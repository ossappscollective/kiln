import { randomBytes, randomUUID } from 'node:crypto';
import {
  type CreateAiClientInput,
  createFakeAiClient,
  type FakeAiClient,
  type FakeAnswer,
} from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { bootRepoApp } from './repo-test-helpers.ts';
import { ASC_SECRET, FakeReplyStore, PLAY_SECRET } from './modules/reviews/test-helpers.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import type { ReviewReplyConnectorFactory } from './modules/reviews/replies.ts';
import type { ReviewConnectorFactory } from './modules/reviews/sync.ts';

/**
 * Shared by the AI tests (docs/adr/0016-ai-foundation.md). No provider and no store is ever contacted: the model is a scripted
 * fake client handed in through `ai.clientFactory`, the reply store is a fake that records every send, and the ASO sources are never used.
 */

export const API_KEY = 'sk-ant-test-0123456789abcdefghij';

type Deps = Partial<Parameters<typeof import('./app.ts').createApp>[0]>;
type Script =
  | FakeAnswer[]
  | ((request: Parameters<FakeAiClient['complete']>[0], index: number) => FakeAnswer);

export type AiBootOptions = {
  /** MRM_AI_ENABLED. Default true. */
  enabled?: boolean;
  /** MRM_AI_ALLOW_PRIVATE_URLS. Default false. */
  allowPrivateUrls?: boolean;
  /** MRM_REVIEW_REPLY_ENABLED. Default true. */
  replyEnabled?: boolean;
  /** Runs a minute per workspace. Default 1000 (the tests that look at it set their own). */
  limiterLimit?: number;
  answers?: Script;
  app?: Deps;
  resolve?: (host: string) => Promise<string[]>;
  /** What the fake client lists as models (raw ids; or an AiError to fail with). */
  models?: Parameters<typeof createFakeAiClient>[0]['models'];
  /** Build the REAL connectors (no client factory): the network is then the `fetch` (Anthropic, OpenAI) or the `exchange` (a compatible server) given here. */
  real?: {
    fetch?: typeof fetch;
    exchange?: (request: { url: URL; method: string; headers: Record<string, string> }) => Promise<{
      status: number;
      headers: Record<string, string | undefined>;
      body: Uint8Array;
      overflow: boolean;
    }>;
  };
};

export async function bootAi(db: Database, options: AiBootOptions = {}) {
  let script: Script = options.answers ?? [{ output: {} }];
  const fake: FakeAiClient = createFakeAiClient({
    ...(options.models !== undefined ? { models: options.models } : {}),
    answers: (request, index) =>
      typeof script === 'function'
        ? script(request, index)
        : (script[Math.min(index, script.length - 1)] ?? { output: {} }),
  });
  const built: CreateAiClientInput[] = [];
  const store = new FakeReplyStore('ios');
  const exchanges: unknown[] = [];
  let clock = Date.UTC(2026, 10, 15, 12, 0, 0);
  const now = () => ++clock;
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    now,
    ai: {
      enabled: options.enabled ?? true,
      ...(options.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
      ...(options.real
        ? {}
        : {
            clientFactory: (input: CreateAiClientInput) => {
              built.push(input);
              return fake;
            },
          }),
      ...(options.real?.fetch ? { fetch: options.real.fetch } : {}),
      ...(options.resolve
        ? {
            resolve: async (host: string) =>
              ((await options.resolve?.(host)) ?? []).map((address) => ({
                address,
                family: address.includes(':') ? 6 : 4,
              })),
          }
        : {}),
      exchange: (options.real?.exchange
        ? (request: Parameters<NonNullable<typeof options.real.exchange>>[0]) => {
            exchanges.push(request);
            return (options.real as NonNullable<typeof options.real>).exchange?.(request);
          }
        : (...args: unknown[]) => {
            exchanges.push(args);
            throw new Error('The network must not be used in tests.');
          }) as never,
      limiter: createTestLimiter({ limit: options.limiterLimit ?? 1000, now }),
    },
    reviews: {
      connectorFactory: (() => store) as unknown as ReviewConnectorFactory,
      ratingFetcher: null,
      reply: {
        enabled: options.replyEnabled ?? true,
        connectorFactory: (() => store) as unknown as ReviewReplyConnectorFactory,
      },
    },
    ...options.app,
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let count = 0;
  const addApp = async (platform: 'ios' | 'android' = 'ios', name?: string) => {
    count += 1;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.ai${count}`,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      name: name ?? `Aqua ${count}`,
    });
    const id = res.body.app.id as string;
    if (platform === 'ios')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const defaultFields = {
    name: 'Aqua',
    subtitle: 'Drink more water',
    description: 'A friendly water reminder that keeps you hydrated all day long.',
    keywords: 'water,hydrate',
    promotional_text: 'Hello',
  };
  const seedListing = async (
    appId: string,
    platform: 'ios' | 'android',
    locale: string,
    fields: Record<string, string> = defaultFields,
  ) => {
    let n = 0;
    for (const [field, value] of Object.entries(fields)) {
      n += 1;
      await db.execute(
        `INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, source_ref, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, 'store', '1.0', ?)`,
        [
          `snap-${appId}-${locale}-${field}`,
          t.workspaceId,
          appId,
          platform,
          locale,
          field,
          value,
          `hash-${field}-${n}-${value.length}`,
          1000 + n,
        ],
      );
    }
  };
  const seedReview = async (
    appId: string,
    body: string,
    over: {
      rating?: number;
      title?: string;
      author?: string;
      language?: string;
      store?: 'appstoreconnect' | 'googleplay';
    } = {},
  ) => {
    const id = randomUUID();
    await db.execute(
      `INSERT INTO app_reviews
         (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory, language,
          app_version, created_at, updated_at, first_seen_at, fetched_at, developer_response, status, assignee_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USA', ?, '1.0', 1, 1, 1, 1, NULL, 'new', NULL)`,
      [
        id,
        t.workspaceId,
        appId,
        over.store ?? 'appstoreconnect',
        `store-${id}`,
        over.rating ?? 1,
        over.title ?? 'Broken',
        body,
        over.author ?? 'Pat Reviewer',
        over.language ?? 'en-US',
      ],
    );
    return id;
  };

  const addKey = (
    kind: 'ai_anthropic' | 'ai_openai' | 'ai_openai_compatible' = 'ai_anthropic',
    cookie = t.owner,
  ) => t.addCredential(kind, JSON.stringify({ apiKey: API_KEY }), cookie);
  const configure = (over: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'PUT', '/ai/config', {
      enabled: true,
      provider: 'anthropic',
      model: 'test-model',
      ...over,
    });
  /** A key and the workspace switch: everything a run needs. */
  const ready = async (over: Record<string, unknown> = {}) => {
    await addKey();
    const res = await configure(over);
    if (res.status !== 200) throw new Error(`configure failed: ${res.text}`);
  };
  const run = (task: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', `/ai/tasks/${task}/run`, body);
  const answer = (...answers: FakeAnswer[]) => {
    script = answers;
  };
  const answerWith = (fn: Exclude<Script, FakeAnswer[]>) => {
    script = fn;
  };
  /** Everything the database keeps that a person did not type: audit rows, events, jobs and usage rows. Never holds prompts or answers. */
  const trail = async () => {
    const audit = await db.query(
      'SELECT action, actor_type, target_type, target_id, detail FROM audit_events',
    );
    const evts = await db.query('SELECT type, payload FROM events');
    const jobs = await db.query('SELECT queue, payload FROM jobs');
    const usage = await db.query('SELECT * FROM ai_usage');
    return JSON.stringify({ audit, evts, jobs, usage });
  };
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as { type: string; subject: { appId?: string }; payload: Record<string, unknown> }[];
  /** A token (created by the owner's session) and a request made with it. */
  const makeToken = async (
    input: { role?: string; actions?: string[]; appIds?: string[] } = {},
  ) => {
    const res = await t.call(t.owner, 'POST', '/tokens', {
      name: 'AI test',
      role: 'admin',
      ...input,
    });
    return res.body?.token as string;
  };
  const bearer = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
  return {
    ...t,
    fake,
    built,
    store,
    exchanges,
    now,
    addApp,
    seedListing,
    seedReview,
    addKey,
    configure,
    ready,
    run,
    answer,
    answerWith,
    trail,
    events,
    makeToken,
    bearer,
  };
}
export type AiBoot = Awaited<ReturnType<typeof bootAi>>;

/** A valid answer of `keyword_ideas` for an App Store app. */
export const keywordAnswer = (
  terms: string[] = ['water reminder app', 'hydration tracker', 'drink log'],
): FakeAnswer => ({
  output: {
    ideas: terms.map((term) => ({ term, reason: 'People search for it.', field: 'keywords' })),
  },
  usage: { inputTokens: 700, outputTokens: 200 },
});
