import { isLocaleCode } from '@kiln/core';
import { callTool, type ToolContext, type ToolOutcome } from './tools.ts';

/**
 * The resources (docs/adr/0023-mcp-server.md): read only documents an assistant (or a person in a client that offers them) can attach.
 * Each is composed from tools, so it is gated exactly like them: a token that cannot use the tool cannot read the resource, and the
 * same shaping (secret removal, untrusted markers, caps) applies.
 *
 *   kiln://apps/{appId}/overview        the app and its store versions, and where its release stands
 *   kiln://apps/{appId}/release-state   where the release stands and what is pending
 *   kiln://apps/{appId}/listing/{locale} the store listing texts of one locale
 */

const ID = '[A-Za-z0-9._:-]{1,100}';
const LOCALE = '[A-Za-z0-9_-]{2,35}';
const OVERVIEW = new RegExp(`^kiln://apps/(${ID})/(overview|release-state)$`);
const LISTING = new RegExp(`^kiln://apps/(${ID})/listing/(${LOCALE})$`);

export const MAX_LISTED_APPS = 25;

export const resourceTemplates = [
  {
    uriTemplate: 'kiln://apps/{appId}/overview',
    name: 'app-overview',
    title: 'App overview',
    description: 'The app, its store versions and where its release stands.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'kiln://apps/{appId}/release-state',
    name: 'release-state',
    title: 'Release state',
    description: 'Where the release stands, who is waiting, and the pending changes.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'kiln://apps/{appId}/listing/{locale}',
    name: 'listing-locale',
    title: 'Listing texts of one locale',
    description: 'The store listing texts of one locale (third party data).',
    mimeType: 'application/json',
  },
] as const;

/** A display name made of letters, digits and plain punctuation only, so a store supplied name cannot carry markup or instructions. */
const plainName = (value: unknown): string =>
  String(value ?? '')
    .replace(/[^\p{L}\p{N} .,'&+-]/gu, '')
    .trim()
    .slice(0, 50);

export async function listResources(
  ctx: ToolContext,
): Promise<{ uri: string; name: string; title: string; description: string; mimeType: string }[]> {
  const called = await callTool(ctx, 'list_apps', {});
  if (called.unknown || !called.outcome.ok) return [];
  const apps = (
    (
      called.outcome.envelope.data as
        | { apps?: { id?: string; name?: string; platform?: string }[] }
        | undefined
    )?.apps ?? []
  ).slice(0, MAX_LISTED_APPS);
  const out: { uri: string; name: string; title: string; description: string; mimeType: string }[] =
    [];
  for (const app of apps) {
    if (typeof app.id !== 'string' || !new RegExp(`^${ID}$`).test(app.id)) continue;
    const label = plainName(app.name) || app.id;
    const platform = typeof app.platform === 'string' ? app.platform : '';
    out.push(
      {
        uri: `kiln://apps/${app.id}/overview`,
        name: `${app.id}-overview`,
        title: `${label} overview`,
        description: `Overview of the ${platform} app ${app.id}.`,
        mimeType: 'application/json',
      },
      {
        uri: `kiln://apps/${app.id}/release-state`,
        name: `${app.id}-release-state`,
        title: `${label} release state`,
        description: `Release state and pending changes of the ${platform} app ${app.id}.`,
        mimeType: 'application/json',
      },
    );
  }
  return out;
}

type Plan = { part: string; tool: string; args: Record<string, unknown> }[];

export function planFor(uri: string): Plan | undefined {
  const overview = OVERVIEW.exec(uri);
  if (overview) {
    const appId = overview[1] as string;
    return overview[2] === 'overview'
      ? [
          { part: 'app', tool: 'get_app', args: { appId } },
          { part: 'status', tool: 'get_app_status', args: { appId } },
        ]
      : [
          { part: 'status', tool: 'get_app_status', args: { appId } },
          { part: 'pending', tool: 'get_pending_changes', args: { appId } },
        ];
  }
  const listing = LISTING.exec(uri);
  if (listing && isLocaleCode(listing[2]))
    return [
      { part: 'listing', tool: 'get_listing', args: { appId: listing[1], locale: listing[2] } },
    ];
  return undefined;
}

export type ReadResult =
  | { ok: true; contents: { uri: string; mimeType: string; text: string }[] }
  | { ok: false; reason: 'unknown' | 'failed'; outcome?: ToolOutcome };

export async function readResource(ctx: ToolContext, uri: string): Promise<ReadResult> {
  if (uri.length > 300) return { ok: false, reason: 'unknown' };
  const plan = planFor(uri);
  if (!plan) return { ok: false, reason: 'unknown' };
  const parts: Record<string, unknown> = {};
  for (const step of plan) {
    const called = await callTool(ctx, step.tool, step.args);
    if (called.unknown) return { ok: false, reason: 'unknown' };
    if (!called.outcome.ok) return { ok: false, reason: 'failed', outcome: called.outcome };
    parts[step.part] = called.outcome.envelope;
  }
  return {
    ok: true,
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(parts) }],
  };
}
