import { randomBytes, randomUUID } from 'node:crypto';
import type { StoreReview } from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { bootRepoApp } from './repo-test-helpers.ts';
import { ASC_SECRET, FakeReplyStore, storeReview } from './review-test-helpers.ts';
import type { ReviewConnectorFactory } from './services/review-sync.ts';

/** Shared by the settings, threshold and translation tests. Everything runs against fakes: no provider is ever contacted. */

export const GOOGLE_KEY = 'AIzaSyFAKE-test-key-0123456789abcdef';
export const GOOGLE_SECRET = JSON.stringify({ apiKey: GOOGLE_KEY });

export type FakeGoogle = {
  fetch: typeof fetch;
  /** Every request made: the URL and the texts sent. */
  requests: { url: string; texts: string[]; target: string }[];
  /** Every text ever sent to the provider. */
  sent(): string[];
  /** How the next calls answer. Default: translate. */
  mode: { status?: number; headers?: Record<string, string>; body?: unknown; throws?: boolean };
};

/** Answers like Google Cloud Translation v2: `[<target>] <text>`, detected language `de`. */
export function fakeGoogle(): FakeGoogle {
  const state: FakeGoogle = {
    requests: [],
    mode: {},
    sent: () => state.requests.flatMap((r) => r.texts),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { q: string[]; target: string };
      state.requests.push({ url: String(input), texts: body.q ?? [], target: body.target });
      if (state.mode.throws) throw new Error('network down');
      if (state.mode.status && state.mode.status !== 200) {
        return new Response(
          JSON.stringify(state.mode.body ?? { error: { message: 'provider says: secret detail' } }),
          {
            status: state.mode.status,
            headers: state.mode.headers ?? {},
          },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            translations: (body.q ?? []).map((q) => ({
              translatedText: `[${body.target}] ${q}`,
              detectedSourceLanguage: 'de',
            })),
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  };
  return state;
}

type Translation = NonNullable<Parameters<typeof import('./app.ts').createApp>[0]['translation']>;

/** The app with an iOS app, a fake store, a controllable clock and a fake Google. */
export async function bootTranslation(
  db: Database,
  options: {
    translation?: Translation;
    google?: FakeGoogle;
    app?: Partial<Parameters<typeof import('./app.ts').createApp>[0]>;
  } = {},
) {
  const google = options.google ?? fakeGoogle();
  const store = new FakeReplyStore('ios');
  const factory = (() => store) as unknown as ReviewConnectorFactory;
  let clock = Date.UTC(2026, 5, 10, 12, 0, 0);
  const now = () => ++clock;
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    now,
    reviews: { connectorFactory: factory, ratingFetcher: null },
    translation: { fetch: google.fetch, ...options.translation },
    credentialTests: { fetch: google.fetch },
    ...options.app,
  });
  const storeCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const appRes = await t.call(t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.acme.app',
    credentialId: storeCredential,
    name: 'Acme',
  });
  const appId = appRes.body.app.id as string;
  await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', appId]);

  const seed = async (
    n: number,
    over: Partial<StoreReview> = {},
    inApp = appId,
    workspace = t.workspaceId,
  ) => {
    const r = storeReview(n, over, 'ios');
    const id = randomUUID();
    await db.execute(
      `INSERT INTO app_reviews
         (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory, language,
          app_version, created_at, updated_at, first_seen_at, fetched_at, developer_response, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [
        id,
        workspace,
        inApp,
        r.store,
        `${inApp.slice(0, 4)}-${r.storeReviewId}`,
        r.rating,
        r.title ?? null,
        r.body,
        null,
        r.territory ?? null,
        r.language ?? null,
        null,
        r.createdAt,
        r.updatedAt,
        1,
        1,
        null,
      ],
    );
    return id;
  };
  const put = (cookie: string, body: unknown) => t.call(cookie, 'PUT', '/settings', body);
  /** Switches translation on with a Google credential (the default provider). */
  const enable = async (extra: Record<string, unknown> = {}) => {
    const id = await t.addCredential('translate_google', GOOGLE_SECRET);
    const res = await put(t.owner, { 'translation.enabled': true, ...extra });
    if (res.status !== 200) throw new Error(`enable failed: ${res.text}`);
    return id;
  };
  const translate = (cookie: string, reviewIds: string[], target?: string, inApp = appId) =>
    t.call(cookie, 'POST', `/apps/${inApp}/reviews/translate`, {
      reviewIds,
      ...(target ? { target } : {}),
    });
  const events = async (type: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200&type=${type}`)).body.events as {
      type: string;
      payload: Record<string, unknown>;
    }[];
  const advance = (ms: number) => {
    clock += ms;
  };
  const usage = async () =>
    (await t.call(t.owner, 'GET', '/settings')).body.translation.usage as {
      day: string;
      used: number;
      budget: number;
    };
  return { ...t, appId, store, google, seed, put, enable, translate, events, advance, now, usage };
}
export type TranslationBoot = Awaited<ReturnType<typeof bootTranslation>>;

/** Captures console output while a test runs: the tests assert that no review text appears in it. */
export function captureConsole() {
  const lines: string[] = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = names.map((n) => console[n]);
  for (const n of names)
    console[n] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  return {
    lines,
    restore() {
      names.forEach((n, i) => {
        console[n] = originals[i] as never;
      });
    },
  };
}
