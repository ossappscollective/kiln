import type { StoreReview } from '@kiln/connectors';
import {
  APPLE_TERRITORIES,
  DEMO_APPS,
  DEVELOPER_REPLY,
  type DemoApp,
  LANGS,
  type Lang,
  type Platform,
  REVIEW_LINES,
} from './content.ts';

/** Small deterministic helpers: the demo shows the same data on every machine. */

export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Alex',
  'Sam',
  'Jordan',
  'Mia',
  'Noah',
  'Lena',
  'Hugo',
  'Sofia',
  'Kenji',
  'Ana',
  'Pierre',
  'Marta',
  'Tom',
  'Yuki',
  'Lucas',
  'Emma',
  'Ravi',
  'Clara',
];
const LANG_WEIGHTS: [Lang, number][] = [
  ['en', 52],
  ['de', 14],
  ['fr', 10],
  ['es', 10],
  ['ja', 8],
  ['pt', 6],
];
const PLAY_LANG = { en: 'en', de: 'de', fr: 'fr', es: 'es', ja: 'ja', pt: 'pt' } as const;
const DAY = 86_400_000;

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;

function weighted(r: () => number): Lang {
  let x = r() * LANG_WEIGHTS.reduce((n, [, w]) => n + w, 0);
  for (const [l, w] of LANG_WEIGHTS) {
    if ((x -= w) < 0) return l;
  }
  return 'en';
}

const ratingOf = (r: () => number): number => {
  const x = r();
  return x < 0.45 ? 5 : x < 0.65 ? 4 : x < 0.77 ? 3 : x < 0.87 ? 2 : 1;
};

/** 90 days of customer reviews for one store record: all ratings, six languages, several territories, some answered. */
export function makeReviews(input: {
  app: DemoApp;
  platform: Platform;
  count: number;
  now: number;
}): StoreReview[] {
  const { app, platform, count, now } = input;
  const r = rng(`${app.key}:${platform}:reviews`);
  const out: StoreReview[] = [];
  const apple = platform !== 'android';
  for (let i = 0; i < count; i++) {
    const lang = weighted(r);
    const rating = ratingOf(r);
    const group = rating >= 4 ? 'good' : rating === 3 ? 'mid' : 'bad';
    const line = pick(r, REVIEW_LINES[lang][group]);
    const age = Math.floor(r() ** 1.4 * 90 * DAY);
    const createdAt = now - age - Math.floor(r() * DAY * 0.5);
    const review: StoreReview = {
      store: apple ? 'appstoreconnect' : 'googleplay',
      platform: apple ? 'ios' : 'android',
      storeReviewId: `${app.key}-${platform}-r${String(i + 1).padStart(3, '0')}`,
      rating,
      title: line.title,
      body: line.body,
      authorName: `${pick(r, NAMES)}${Math.floor(r() * 90) + 10}`,
      createdAt,
      updatedAt: createdAt,
      ...(apple
        ? { territory: pick(r, APPLE_TERRITORIES[lang]) }
        : {
            language: PLAY_LANG[lang],
            appVersion: pick(r, [app.live, app.live, prevVersion(app.live)]),
            device: pick(r, ['pixel8', 'sm-s928b', 'oneplus12', 'pixel7a']),
          }),
    };
    if (apple && platform === 'macos') review.platform = 'macos';
    // Older low ratings are mostly answered; one review carries a developer response in every record.
    const answered =
      (rating <= 2 && age > 10 * DAY && r() < 0.6) || (rating >= 4 && r() < 0.06) || i === 3;
    if (answered)
      review.developerResponse = {
        body: DEVELOPER_REPLY[lang],
        at: createdAt + Math.floor((1 + r() * 3) * DAY),
      };
    out.push(review);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

const prevVersion = (v: string) => {
  const [a, b, c] = v.split('.');
  return Number(c) > 0 ? `${a}.${b}.${Number(c) - 1}` : `${a}.${Number(b) - 1}.0`;
};

// ---- analytics ---------------------------------------------------------------------------------------------------------

export type SeriesPoint = { date: string; value: number };

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Daily values for the last `days` days with a weekly rhythm, a slow trend and noise. Deterministic per `name`. */
export function dailySeries(
  name: string,
  days: number,
  base: number,
  options: { trend?: number; noise?: number; weekend?: number; end?: number; round?: boolean } = {},
): SeriesPoint[] {
  const r = rng(`series:${name}`);
  const end = options.end ?? Date.now();
  const out: SeriesPoint[] = [];
  for (let i = days; i >= 1; i--) {
    const ms = end - i * DAY;
    const dow = new Date(ms).getUTCDay();
    const week = dow === 0 || dow === 6 ? (options.weekend ?? 0.85) : 1;
    const trend = 1 + ((options.trend ?? 0.2) * (days - i)) / days;
    const noise = 1 + (r() - 0.5) * 2 * (options.noise ?? 0.12);
    const v = base * week * trend * noise;
    out.push({ date: iso(ms), value: options.round === false ? v : Math.max(0, Math.round(v)) });
  }
  return out;
}

export const appFor = (key: string): DemoApp => DEMO_APPS.find((a) => a.key === key) as DemoApp;
export { LANGS };
