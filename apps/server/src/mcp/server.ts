import { z } from 'zod';
import { promptByName, prompts } from './prompts.ts';
import {
  ERROR_CODES,
  type JsonRpcResponse,
  RPC_MESSAGES,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  classify,
  negotiateVersion,
  rpcError,
  rpcResult,
} from './protocol.ts';
import { listResources, readResource, resourceTemplates } from './resources.ts';
import { type ToolContext, ERROR_MESSAGES, callTool, describeTool, issuesOf, visibleTools } from './tools.ts';

/**
 * The message handler (docs/adr/0023-mcp-server.md): JSON-RPC in, JSON-RPC out, no transport and no state. `routes.ts` authenticates the
 * request and builds the context; everything here is a pure function of the message and that context, which is what the tests drive.
 */

export type ServerContext = ToolContext & {
  /** The server version, for `serverInfo`. */
  version: string;
  /** The `MCP-Protocol-Version` header of the request, when the client sent one: decides whether `structuredContent` is added. */
  protocolVersion?: string | undefined;
};

const initializeParams = z.object({ protocolVersion: z.string().max(40), capabilities: z.record(z.unknown()).optional(), clientInfo: z.object({ name: z.string().max(200), version: z.string().max(100).optional(), title: z.string().max(200).optional() }).passthrough().optional() }).passthrough();
const callParams = z.object({ name: z.string().min(1).max(100), arguments: z.record(z.unknown()).optional() }).passthrough();
const getPromptParams = z.object({ name: z.string().min(1).max(100), arguments: z.record(z.string().max(200)).optional() }).passthrough();
const readParams = z.object({ uri: z.string().min(1).max(300) }).passthrough();

const text = (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }];

/** Handles one message. Returns undefined for a notification or a response (nothing to answer). */
export async function handleMessage(ctx: ServerContext, message: unknown): Promise<JsonRpcResponse | undefined> {
  const incoming = classify(message);
  if (incoming.kind === 'notification' || incoming.kind === 'response') return undefined;
  if (incoming.kind === 'invalid') return rpcError(incoming.id, ERROR_CODES.invalidRequest, RPC_MESSAGES.invalidRequest);
  const { id, method, params } = incoming;
  try {
    switch (method) {
      case 'initialize': {
        const parsed = initializeParams.safeParse(params);
        if (!parsed.success) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.invalidParams);
        return rpcResult(id, {
          protocolVersion: negotiateVersion(parsed.data.protocolVersion),
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Mobile Release Manager', version: ctx.version },
          instructions: SERVER_INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: visibleTools(ctx.principal, ctx.flags).map(describeTool) });
      case 'tools/call': {
        const parsed = callParams.safeParse(params);
        if (!parsed.success) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.invalidParams);
        const called = await callTool(ctx, parsed.data.name, parsed.data.arguments ?? {});
        if (called.unknown) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.unknownTool);
        if (!called.outcome.ok) return rpcResult(id, { content: text(called.outcome.error), isError: true });
        const { envelope } = called.outcome;
        return rpcResult(id, { content: text(envelope), ...(ctx.protocolVersion === '2025-06-18' ? { structuredContent: envelope } : {}), isError: false });
      }
      case 'resources/list':
        return rpcResult(id, { resources: await listResources(ctx) });
      case 'resources/templates/list':
        return rpcResult(id, { resourceTemplates });
      case 'resources/read': {
        const parsed = readParams.safeParse(params);
        if (!parsed.success) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.invalidParams);
        const read = await readResource(ctx, parsed.data.uri);
        if (read.ok) return rpcResult(id, { contents: read.contents });
        if (read.reason === 'failed' && read.outcome && !read.outcome.ok) {
          const code = read.outcome.error.error;
          return rpcError(id, code === 'not_found' ? ERROR_CODES.resourceNotFound : ERROR_CODES.invalidParams, ERROR_MESSAGES[code]);
        }
        return rpcError(id, ERROR_CODES.resourceNotFound, RPC_MESSAGES.unknownResource);
      }
      case 'prompts/list':
        return rpcResult(id, { prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })) });
      case 'prompts/get': {
        const parsed = getPromptParams.safeParse(params);
        if (!parsed.success) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.invalidParams);
        const prompt = promptByName.get(parsed.data.name);
        if (!prompt) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.unknownPrompt);
        const args = prompt.schema.safeParse(parsed.data.arguments ?? {});
        if (!args.success) return rpcError(id, ERROR_CODES.invalidParams, RPC_MESSAGES.invalidParams, { issues: issuesOf(args.error) });
        return rpcResult(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args.data as Record<string, string | undefined>) } }] });
      }
      default:
        return rpcError(id, ERROR_CODES.methodNotFound, RPC_MESSAGES.methodNotFound);
    }
  } catch {
    // Nothing of the failure is passed on: it could hold a path or a value.
    return rpcError(id, ERROR_CODES.internal, RPC_MESSAGES.internal);
  }
}
