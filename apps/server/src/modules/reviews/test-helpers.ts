import { randomBytes, randomUUID } from 'node:crypto';
import {
  APPLE_REPLY_LIMIT,
  type ListReviewsResult,
  PLAY_REPLY_LIMIT,
  ReplyOutcomeUnknownError,
  type ReplyToReviewInput,
  type ReplyToReviewResult,
  type StoreError,
  type StoreReview,
  type StoreReviewReplyConnector,
} from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import type { Database } from '@mrm/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import type { ReviewReplyConnectorFactory } from './replies.ts';
import type { ReviewConnectorFactory, ReviewConnectorInput } from './sync.ts';

/** Shared by the reply and inbox tests. Everything runs against fakes: no store is ever contacted. */

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
export const ASC_SECRET = JSON.stringify({
  keyId: 'ABC123DEFG',
  issuerId: 'issuer-1',
  privateKey: PEM,
});
export const PLAY_SECRET = JSON.stringify({
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: PEM,
});

export type ReplyBehavior =
  | { kind: 'ok'; state?: string }
  | { kind: 'refuse'; error: StoreError }
  | { kind: 'unknown'; applied: boolean };

/** A store that can be read and replied to, remembers every request, and can be told how to fail. */
export class FakeReplyStore implements StoreReviewReplyConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  readonly replyLimit: number;
  reviews: StoreReview[] = [];
  behavior: ReplyBehavior = { kind: 'ok' };
  readError: unknown;
  replies: ReplyToReviewInput[] = [];
  reads: string[] = [];
  /** When set, a reply waits for it: lets a test hold a send in flight. */
  gate: Promise<void> | undefined;
  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'ios' ? 'appstoreconnect' : 'googleplay';
    this.replyLimit = platform === 'ios' ? APPLE_REPLY_LIMIT : PLAY_REPLY_LIMIT;
  }
  async listReviews(): Promise<ListReviewsResult> {
    return { reviews: this.reviews, complete: true, warnings: [], skipped: 0 };
  }
  async getReview(reviewId: string): Promise<StoreReview | undefined> {
    this.reads.push(reviewId);
    if (this.readError) throw this.readError;
    return this.reviews.find((r) => r.storeReviewId === reviewId);
  }
  #apply(input: ReplyToReviewInput, state?: string) {
    const found = this.reviews.find((r) => r.storeReviewId === input.reviewId);
    if (found)
      found.developerResponse = { body: input.text, at: Date.now(), ...(state ? { state } : {}) };
  }
  async replyToReview(input: ReplyToReviewInput): Promise<ReplyToReviewResult> {
    this.replies.push(input);
    if (this.gate) await this.gate;
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) this.#apply(input);
      throw new ReplyOutcomeUnknownError(this.store, 'timed out');
    }
    this.#apply(input, b.state);
    return {
      repliedAt: Date.now(),
      ...(b.state ? { state: b.state } : {}),
      ...(this.platform === 'ios' ? { storeResponseId: 'resp-1' } : {}),
    };
  }
}

export const storeReview = (
  n: number,
  over: Partial<StoreReview> = {},
  platform: Platform = 'ios',
): StoreReview => ({
  store: platform === 'ios' ? 'appstoreconnect' : 'googleplay',
  platform,
  storeReviewId: `rev-${n}`,
  rating: 5,
  title: `Title ${n}`,
  body: `Body of review ${n}`,
  authorName: `Reviewer ${n}`,
  territory: 'USA',
  createdAt: 1_700_000_000_000 + n * 1000,
  updatedAt: 1_700_000_000_000 + n * 1000,
  ...over,
});

type Deps = NonNullable<Parameters<typeof import('../../app.ts').createApp>[0]['reviews']>;

export async function bootReviews(db: Database, reviews: Deps = {}) {
  const stores = { ios: new FakeReplyStore('ios'), android: new FakeReplyStore('android') };
  const built: ReviewConnectorInput[] = [];
  const factory = (input: ReviewConnectorInput) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  let clock = Date.now();
  const now = () => ++clock;
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    now,
    reviews: {
      connectorFactory: factory as ReviewConnectorFactory,
      ratingFetcher: null,
      ...reviews,
      reply: {
        enabled: true,
        connectorFactory: factory as ReviewReplyConnectorFactory,
        ...reviews.reply,
      },
    },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const addApp = async (platform: Platform, name?: string) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.app${appCount}`,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      name: name ?? `App ${appCount}`,
    });
    const id = res.body.app.id as string;
    if (platform === 'ios')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  /** Inserts reviews directly (and, for the reply tests, into the fake store too). */
  const seed = async (
    appId: string,
    platform: Platform,
    n: number,
    over: Partial<StoreReview> & {
      status?: string;
      assignee?: string | null;
      response?: string | null;
    } = {},
  ) => {
    const { status, assignee, response, ...store } = over;
    const r = storeReview(n, store, platform);
    const id = randomUUID();
    await db.execute(
      `INSERT INTO app_reviews
         (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory, language,
          app_version, created_at, updated_at, first_seen_at, fetched_at, developer_response, status, assignee_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        t.workspaceId,
        appId,
        r.store,
        `${appId.slice(0, 4)}-${r.storeReviewId}`,
        r.rating,
        r.title ?? null,
        r.body,
        r.authorName ?? null,
        r.territory ?? null,
        r.language ?? null,
        r.appVersion ?? null,
        r.createdAt,
        r.updatedAt,
        1,
        1,
        response === undefined || response === null
          ? null
          : JSON.stringify({ body: response, at: 5, state: null }),
        status ?? 'new',
        assignee ?? null,
      ],
    );
    (platform === 'ios' ? stores.ios : stores.android).reviews.push({
      ...r,
      storeReviewId: `${appId.slice(0, 4)}-${r.storeReviewId}`,
      ...(response ? { developerResponse: { body: response, at: 5 } } : {}),
    });
    return id;
  };
  const userId = async (email = 'ada@example.com') =>
    String((await db.query('SELECT id FROM users WHERE email = ?', [email]))[0]?.id);
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as {
      type: string;
      payload: Record<string, unknown>;
    }[];
  return { ...t, stores, built, now, addApp, seed, userId, events, iosCredential, playCredential };
}
export type ReviewsBoot = Awaited<ReturnType<typeof bootReviews>>;
