import { type Action, can, canToken, tokenExplicitOnlyActions } from '@mrm/core';
import type { z } from 'zod';
import {
  type JsonSchema,
  type Operation,
  tokenAllowedFor,
  zodToJsonSchema,
} from '../operations/openapi.ts';
import type { TokenPrincipal } from '../services/tokens.ts';
import { FLAG_ENV, type McpFlags } from './flags.ts';
import { fit, newMarkerId, UNTRUSTED_NOTICE } from './shape.ts';
import {
  type Json,
  operationById,
  type Query,
  type ToolDef,
  type ToolKind,
  tools,
} from './tool-defs.ts';

export type { McpFlags } from './flags.ts';
export { type ToolDef, type ToolKind, tools } from './tool-defs.ts';

/**
 * Which tools a token gets, and running one (docs/adr/0023-mcp-server.md). A tool call becomes a request to the SAME HTTP routes any API
 * client uses, with the caller's own token (see `Dispatch`), so the token check, the operation allow-list, the role ceiling, the app
 * restriction, the rate limit and the audit attribution are the routes' own and not a copy. This file adds the gate that decides what is
 * even offered, the shaping of the answer, and the fixed vocabulary of errors.
 */

export type DispatchRequest = { method: string; path: string; query?: Query; body?: unknown };
export type DispatchResult = { status: number; body: unknown };
export type Dispatch = (request: DispatchRequest) => Promise<DispatchResult>;

export type Unavailable =
  | 'no_operation'
  | 'token_not_allowed'
  | 'role'
  | 'action_not_named'
  | 'switch_off'
  | 'workspace_wide';

export const operationOf = (tool: ToolDef): Operation | undefined =>
  tool.op ? operationById.get(tool.op) : undefined;

type Principal = Pick<TokenPrincipal, 'ceiling' | 'actions' | 'appIds'>;

/**
 * Why a tool is not offered to this token, or undefined when it is. The same rules as the routes (bearer.ts) plus two of ours: a
 * `write` or `preview` tool needs the action NAMED in the token's list (a token without a list never gets one, so widening an old token
 * cannot switch it on), and the server's switch for the feature must be on.
 */
export function unavailableReason(
  tool: ToolDef,
  principal: Principal,
  flags: McpFlags,
): Unavailable | undefined {
  if (tool.kind === 'meta') return undefined;
  const operation = operationOf(tool);
  if (!operation) return 'no_operation';
  if (!tokenAllowedFor(operation) || typeof operation.access !== 'object')
    return 'token_not_allowed';
  const action = operation.access.action;
  if (!can(principal.ceiling, action)) return 'role';
  if (!canToken(principal.ceiling, principal.actions, action)) return 'action_not_named';
  if (tool.kind !== 'read' && principal.actions === null) return 'action_not_named';
  if (tool.flag && !flags[tool.flag]) return 'switch_off';
  if (principal.appIds !== null && !operation.appScope) return 'workspace_wide';
  return undefined;
}

export const visibleTools = (principal: Principal, flags: McpFlags): ToolDef[] =>
  tools.filter((t) => unavailableReason(t, principal, flags) === undefined);

const toolByName = new Map(tools.map((t) => [t.name, t]));
export const findTool = (name: string): ToolDef | undefined => toolByName.get(name);

/** The tool as `tools/list` shows it. */
export function describeTool(tool: ToolDef): {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: Record<string, unknown>;
} {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.input),
    annotations: {
      title: tool.title,
      readOnlyHint: tool.kind !== 'write',
      destructiveHint: false,
      idempotentHint: tool.kind !== 'write',
      openWorldHint: tool.kind !== 'meta',
    },
  };
}

/** The actions of the read tools that a `viewer` holds and that need no explicit naming: what the "MCP read-only" token preset lists. */
export function readOnlyActions(): Action[] {
  const found = new Set<Action>();
  for (const tool of tools) {
    if (tool.kind !== 'read') continue;
    const operation = operationOf(tool);
    if (!operation || typeof operation.access !== 'object') continue;
    const action = operation.access.action;
    if (tokenExplicitOnlyActions.includes(action) || !can('viewer', action)) continue;
    found.add(action);
  }
  return [...found];
}

// ---------------------------------------------------------------------------------------------
// Errors: a fixed vocabulary. Nothing a client sent, and no text a route produced, is passed on.

export const ERROR_MESSAGES = {
  invalid_input: 'The input is not valid for this tool.',
  not_found: 'Nothing was found for that id, or this token cannot see it.',
  forbidden: 'This token does not allow that.',
  confirmation_required: 'A person has to confirm this in the web app.',
  feature_disabled: 'This feature is switched off on the server.',
  conflict: 'The state does not allow this now.',
  rate_limited: 'Too many requests. Try again later.',
  too_large: 'The result is too large to return. Narrow the request.',
  unavailable: 'The server could not do this right now.',
  unauthorized: 'The token is no longer valid.',
} as const;
export type ToolErrorCode = keyof typeof ERROR_MESSAGES;

export type ToolError = {
  error: ToolErrorCode;
  message: string;
  issues?: { path: string; code: string }[];
  upstream?: string;
  retryAfterSeconds?: number;
};
export type ToolOutcome =
  | { ok: true; envelope: Record<string, unknown> }
  | { ok: false; error: ToolError };

const fail = (code: ToolErrorCode, extra: Record<string, unknown> = {}): ToolOutcome => ({
  ok: false,
  error: { error: code, message: ERROR_MESSAGES[code], ...extra },
});

/** zod issues as a path and the issue code only: the message of an issue can quote the value, so it is not passed on. */
export const issuesOf = (error: z.ZodError): { path: string; code: string }[] =>
  error.issues
    .slice(0, 10)
    .map((i) => ({ path: i.path.map(String).join('.').slice(0, 100), code: i.code }));

function mapStatus(status: number, body: unknown): ToolOutcome {
  const raw = (body as Json | null)?.error;
  const code = typeof raw === 'string' && /^[a-z0-9_]{1,60}$/.test(raw) ? raw : undefined;
  const upstream = code ? { upstream: code } : {};
  if (code && /(disabled|not_enabled|switched_off)/.test(code))
    return fail('feature_disabled', upstream);
  if (status === 400 || status === 422) return fail('invalid_input', upstream);
  if (status === 401) return fail('unauthorized');
  if (status === 403)
    return fail(
      code === 'step_up_required_human' ? 'confirmation_required' : 'forbidden',
      upstream,
    );
  if (status === 404) return fail('not_found');
  if (status === 409) return fail('conflict', upstream);
  if (status === 413) return fail('too_large');
  if (status === 429) {
    const wait = Number((body as Json | null)?.retryAfterSeconds);
    return fail(
      'rate_limited',
      Number.isFinite(wait) && wait > 0
        ? { retryAfterSeconds: Math.min(3600, Math.floor(wait)) }
        : {},
    );
  }
  return fail('unavailable', upstream);
}

// ---------------------------------------------------------------------------------------------
// Running a tool

const fillPath = (template: string, values: Record<string, string>): string =>
  template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) =>
    encodeURIComponent(values[name] ?? ''),
  );

/** The hash a person confirms, from a preview answer: `confirmHash` of one action, or the `planHash` of a batch. */
export function confirmHashOf(json: Json): string | null {
  const direct =
    json?.preview?.confirmHash ?? json?.plan?.planHash ?? json?.confirmHash ?? json?.planHash;
  return typeof direct === 'string' && /^[0-9a-f]{16,128}$/i.test(direct) ? direct : null;
}

export type AuditEntry = {
  tool: string;
  kind: ToolKind;
  appId?: string;
  ok: boolean;
  code?: string;
};

export type ToolContext = {
  principal: TokenPrincipal;
  flags: McpFlags;
  dispatch: Dispatch;
  /** Where the web app is, for links ("https://mrm.example.com"). */
  origin: string;
  /** Called after a write or preview tool. Ids only: no argument, no text. */
  audit?: (entry: AuditEntry) => Promise<void>;
};

export type CallResult = { unknown: true } | { unknown: false; outcome: ToolOutcome };

export async function callTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<CallResult> {
  const tool = toolByName.get(name);
  // A tool this token may not use does not exist for it: same answer as an unknown name.
  if (!tool || unavailableReason(tool, ctx.principal, ctx.flags) !== undefined)
    return { unknown: true };
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success)
    return { unknown: false, outcome: fail('invalid_input', { issues: issuesOf(parsed.error) }) };
  const args = parsed.data as Json;
  const outcome = await run(ctx, tool, args);
  if (tool.kind === 'write' || tool.kind === 'preview') {
    const entry: AuditEntry = {
      tool: tool.name,
      kind: tool.kind,
      ok: outcome.ok,
      ...(typeof args.appId === 'string' ? { appId: args.appId } : {}),
      ...(outcome.ok ? {} : { code: outcome.error.error }),
    };
    await ctx.audit?.(entry).catch(() => undefined);
  }
  return { unknown: false, outcome };
}

async function run(ctx: ToolContext, tool: ToolDef, args: Json): Promise<ToolOutcome> {
  if (tool.kind === 'meta') return wrap(tool, whoamiData(ctx));
  const operation = operationOf(tool);
  if (!operation) return fail('unavailable');
  const values: Record<string, string> = { workspaceId: ctx.principal.workspaceId };
  for (const [param, arg] of Object.entries(tool.params ?? {})) values[param] = String(args[arg]);
  let result: DispatchResult;
  try {
    result = await ctx.dispatch({
      method: operation.method.toUpperCase(),
      path: fillPath(operation.path, values),
      ...(tool.query ? { query: tool.query(args) } : {}),
      ...(tool.body ? { body: tool.body(args) } : {}),
    });
  } catch {
    return fail('unavailable');
  }
  if (result.status < 200 || result.status >= 300) return mapStatus(result.status, result.body);
  const json = (result.body ?? {}) as Json;
  if (tool.kind === 'preview') return previewOutcome(ctx, tool, json, args);
  return wrap(tool, tool.shape ? tool.shape(json, args) : json);
}

function wrap(tool: ToolDef, data: unknown, extra: Record<string, unknown> = {}): ToolOutcome {
  const fitted = fit(data, {
    markerId: newMarkerId(),
    ...(tool.untrusted ? { untrustedKeys: new Set(tool.untrusted) } : {}),
    ...(tool.drop ? { dropKeys: new Set(tool.drop) } : {}),
    ...(tool.limits ? { limits: tool.limits } : {}),
  });
  if (!fitted) return fail('too_large');
  return {
    ok: true,
    envelope: {
      ...extra,
      data: fitted.value,
      ...(fitted.cuts.length > 0
        ? {
            truncated: fitted.cuts.slice(0, 20),
            truncatedNote:
              'Some of the result was cut to keep it small. Narrow the request or ask for the next page.',
          }
        : {}),
      ...((tool.untrusted?.length ?? 0) > 0 ? { notice: UNTRUSTED_NOTICE } : {}),
    },
  };
}

function previewOutcome(ctx: ToolContext, tool: ToolDef, json: Json, args: Json): ToolOutcome {
  const url = `${ctx.origin}/#/portfolio/${encodeURIComponent(String(args.appId))}/${tool.link ?? 'pending'}`;
  return wrap(tool, json.preview ?? json.plan ?? json, {
    applied: false,
    confirmHash: confirmHashOf(json),
    confirmInApp: {
      url,
      how: 'Open the link in the Kiln web app, review this preview and confirm there with your passkey or password. An API token, and so this assistant, cannot confirm or apply it.',
    },
    previewNotice: 'This was a preview. Nothing was changed. There is no tool that applies it.',
  });
}

function whoamiData(ctx: ToolContext): Record<string, unknown> {
  const { principal, flags } = ctx;
  const available = visibleTools(principal, flags);
  const names = (kind: ToolKind) => available.filter((t) => t.kind === kind).map((t) => t.name);
  return {
    token: {
      name: principal.name,
      role: principal.ceiling,
      apps: principal.appIds === null ? 'all' : principal.appIds.length,
      actionsListed: principal.actions !== null,
    },
    tools: {
      total: available.length,
      read: names('read'),
      write: names('write'),
      preview: names('preview'),
    },
    switchesOff: (Object.keys(flags) as (keyof McpFlags)[])
      .filter((k) => !flags[k])
      .map((k) => FLAG_ENV[k]),
    canApply: false,
  };
}
