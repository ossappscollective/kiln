import { type Translate, translator } from '../../i18n/catalogs.ts';
import { type Params, SOURCE_LOCALE } from '../../i18n/runtime.ts';
import type { AlertData } from './catalog-core.ts';

/**
 * The sentences of an alert (title and body) in a language (docs/i18n-server.md, ADR 0045). The catalog is
 * `apps/server/locales/alerts/<language>.json`, key `<alert type>.title` and `<alert type>.body`, with a suffix for a variant (`.noStore`) and
 * `_one`/`_other` for a plural. English is the source: `AlertDef.title` and `.body` read it (catalog-core.ts), so the stored row, the
 * inbox and the English email say the same thing. This file only picks the key and prepares the values: names, ids and codes pass
 * through untouched, numbers, dates and durations go through `Intl` in the language, a state or a role becomes its word.
 */

/** `in_review` to `inReview`: catalog keys are dot-separated camelCase segments (scripts/i18n.mjs). */
export const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** A key with snake_case alert ids (`release.in_review.title`) as a catalog key; a `_one`/`_other` plural suffix stays. */
export const camelKey = (key: string): string =>
  key
    .split('.')
    .map((seg) => {
      const m = /^(.*?)(_one|_other)?$/.exec(seg);
      return camel(m?.[1] ?? seg) + (m?.[2] ?? '');
    })
    .join('.');

type Msg = readonly [key: string, params?: Params];
type Spec = { title: Msg; body: Msg };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const number = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

type Fmt = {
  t: Translate;
  d: AlertData;
  /** The app's name (or its id, or "an app"). */
  app: string;
  /** The app and its version, `Lyynk 1.2`. */
  appVer: string;
  n: (v: unknown) => string;
  unit: (v: unknown, unit: 'minute' | 'hour' | 'day') => string;
  date: (v: unknown) => string;
  status: (v: unknown) => string;
  role: (v: unknown) => string;
  word: (v: unknown) => string;
};

function formatter(t: Translate, d: AlertData): Fmt {
  const locale = t.locale;
  const n = (v: unknown): string => {
    const x = number(v);
    if (x === undefined) return '?';
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(x);
    } catch {
      return String(x);
    }
  };
  const unit = (v: unknown, u: 'minute' | 'hour' | 'day'): string => {
    const x = number(v);
    if (x === undefined) return '?';
    try {
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: u,
        unitDisplay: 'long',
        maximumFractionDigits: 0,
      }).format(x);
    } catch {
      return String(x);
    }
  };
  const date = (v: unknown): string => {
    const s = text(v);
    if (!s) return '?';
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(`${s.slice(0, 10)}T00:00:00Z`),
      );
    } catch {
      return s;
    }
  };
  // A word of a closed list becomes its translation; anything else (a value this build does not know) stays as written.
  const known = (prefix: string, ids: readonly string[]) => (v: unknown): string => {
    const s = text(v);
    if (!s) return t(`alerts:common.unknown`);
    return ids.includes(s) ? t(`alerts:${prefix}.${camel(s)}`) : s;
  };
  const app = String(d.appName ?? d.appId ?? t('alerts:common.anApp'));
  const version = text(d.version);
  return {
    t,
    d,
    app,
    appVer: version ? `${app} ${version}` : app,
    n,
    unit,
    date,
    status: known('status', STATES),
    role: known('role', ['owner', 'admin', 'member', 'viewer']),
    word: (v) => text(v) ?? t('alerts:common.unknown'),
  };
}

const STATES = [
  'draft',
  'build_chosen',
  'ready',
  'in_review',
  'rejected',
  'approved',
  'propagating',
  'rolling_out',
  'live',
  'halted',
] as const;

const store = (d: AlertData): string | undefined =>
  text(d.store) ?? (d.platform === 'ios' ? 'App Store' : d.platform === 'android' ? 'Google Play' : undefined);

/** Title and body of each alert type: which key, which values. A type that is not here has no translation (its stored text is used). */
/** `2.5.0 (42)`, `42`, `2.5.0` or undefined: how a build is named in a TestFlight alert. */
const testflightBuild = (d: AlertData): string | undefined => {
  const build = text(d.buildNumber);
  const version = text(d.version);
  return build && version ? `${version} (${build})` : (build ?? version);
};

function testflightSpec(f: Fmt, kind: 'feedback' | 'crash'): Spec {
  const base = `testflight.${kind}`;
  const count = number(f.d.count);
  if (f.d.grouped === true && count !== undefined) {
    return {
      title: [`${base}.title.grouped`, { app: f.app, count }],
      body: [`${base}.body.grouped`, { app: f.app, count }],
    };
  }
  const build = testflightBuild(f.d);
  return {
    title: [`${base}.title`, { app: f.app }],
    body: build ? [`${base}.body`, { app: f.app, build }] : [`${base}.body.noBuild`, { app: f.app }],
  };
}

const specs: Record<string, (f: Fmt) => Spec> = {
  'release.rejected': (f) => ({
    title: ['release.rejected.title', { app: f.appVer }],
    body: [
      'release.rejected.body',
      { app: f.appVer, from: f.status(f.d.from), to: f.status('rejected') },
    ],
  }),
  'release.approved': (f) => ({
    title: ['release.approved.title', { app: f.appVer }],
    body: ['release.approved.body', { app: f.appVer }],
  }),
  'release.live': (f) => {
    const k = f.d.to === 'rolling_out' ? 'rollingOut' : 'live';
    return {
      title: [`release.live.title.${k}`, { app: f.appVer }],
      body: [`release.live.body.${k}`, { app: f.appVer }],
    };
  },
  'release.in_review': (f) => ({
    title: ['release.in_review.title', { app: f.appVer }],
    body: [
      'release.in_review.body',
      { app: f.appVer, from: f.status(f.d.from), to: f.status('in_review') },
    ],
  }),
  'release.halted': (f) => {
    const track = text(f.d.track);
    return {
      title: ['release.halted.title', { app: f.appVer }],
      body: track
        ? ['release.halted.body', { app: f.appVer, track }]
        : ['release.halted.body.noTrack', { app: f.appVer }],
    };
  },
  'release.stalled': (f) => {
    const step = text(f.d.step);
    return {
      title: step
        ? ['release.stalled.title', { app: f.appVer, step }]
        : ['release.stalled.title.noStep', { app: f.appVer }],
      body: step
        ? ['release.stalled.body', { app: f.appVer, step }]
        : ['release.stalled.body.noStep', { app: f.appVer }],
    };
  },
  'plan.deadline_overdue': (f) => {
    const days = number(f.d.daysOverdue);
    return {
      title:
        days === undefined
          ? ['plan.deadline_overdue.title.noDays', { app: f.appVer }]
          : ['plan.deadline_overdue.title', { app: f.appVer, days: f.unit(days, 'day') }],
      body: [
        'plan.deadline_overdue.body',
        { app: f.appVer, date: f.date(f.d.targetDate), count: number(f.d.openRequiredItems) ?? 0 },
      ],
    };
  },
  'plan.deadline_due_soon': (f) => ({
    title: ['plan.deadline_due_soon.title', { app: f.appVer }],
    body: [
      f.d.blocked ? 'plan.deadline_due_soon.body.blocked' : 'plan.deadline_due_soon.body',
      { app: f.appVer, date: f.date(f.d.targetDate) },
    ],
  }),
  'plan.rollout_step_due': (f) => ({
    title: [
      'plan.rollout_step_due.title',
      { app: f.appVer, index: f.n(f.d.index), total: f.n(f.d.total) },
    ],
    body: [
      'plan.rollout_step_due.body',
      { app: f.appVer, percent: f.n(f.d.percent), count: number(f.d.minutesLate) ?? 0 },
    ],
  }),
  'review.low_rating': (f) => {
    const rating = number(f.d.rating);
    const s = store(f.d);
    return {
      title:
        rating === undefined
          ? ['review.low_rating.title.noRating', { app: f.app }]
          : ['review.low_rating.title', { app: f.app, count: rating }],
      body:
        rating === undefined
          ? ['review.low_rating.body.noRating', { app: f.app }]
          : s
            ? ['review.low_rating.body', { app: f.app, store: s, count: rating }]
            : ['review.low_rating.body.noStore', { app: f.app, count: rating }],
    };
  },
  'testflight.feedback': (f) => testflightSpec(f, 'feedback'),
  'testflight.crash': (f) => testflightSpec(f, 'crash'),
  'review.new': (f) => {
    const s = store(f.d);
    if (f.d.grouped === true) {
      const count = number(f.d.count);
      return {
        title:
          count === undefined
            ? ['review.new.title.several', { app: f.app }]
            : ['review.new.title.grouped', { app: f.app, count }],
        body: [
          count === undefined
            ? 'review.new.body.several'
            : !s
              ? 'review.new.body.grouped.noStore'
              : f.d.baseline === true
                ? 'review.new.body.grouped.baseline'
                : 'review.new.body.grouped',
          { app: f.app, store: s, count },
        ],
      };
    }
    const rating = number(f.d.rating);
    return {
      title:
        rating === undefined
          ? ['review.low_rating.title.noRating', { app: f.app }]
          : ['review.low_rating.title', { app: f.app, count: rating }],
      body:
        rating === undefined
          ? ['review.low_rating.body.noRating', { app: f.app }]
          : s
            ? ['review.low_rating.body', { app: f.app, store: s, count: rating }]
            : ['review.low_rating.body.noStore', { app: f.app, count: rating }],
    };
  },
  'review.sync_failed': (f) => {
    const failures = number(f.d.failures);
    return {
      title: ['review.sync_failed.title', { app: f.app }],
      body:
        failures === undefined || failures === 0
          ? ['review.sync_failed.body', { app: f.app, code: f.word(f.d.code) }]
          : [
              'review.sync_failed.body.failures',
              { app: f.app, code: f.word(f.d.code), count: failures },
            ],
    };
  },
  'review.unanswered': (f) => {
    const count = number(f.d.count);
    const hours = f.unit(f.d.waitingHours, 'hour');
    return {
      title:
        count === undefined
          ? ['review.unanswered.title.some']
          : ['review.unanswered.title', { count }],
      body:
        count === undefined
          ? ['review.unanswered.body.some', { hours }]
          : ['review.unanswered.body', { count, hours }],
    };
  },
  'health.crash_regression': (f) => {
    // Rates are fractions: Google Play's are a share of users (shown as a percentage), the App Store's are crashes per session (shown per 1,000).
    const play = f.d.platform === 'android';
    const scale = play ? 100 : 1000;
    const shown = (v: unknown) => f.n(typeof v === 'number' ? v * scale : undefined);
    const version = text(f.d.versionName) ?? text(f.d.version) ?? '?';
    return {
      title: ['health.crash_regression.title', { app: f.app, version }],
      body: [
        play ? 'health.crash_regression.body.share' : 'health.crash_regression.body.perSessions',
        { app: f.app, version, previous: text(f.d.previous) ?? '?', before: shown(f.d.before), after: shown(f.d.after) },
      ],
    };
  },
  'rating.dropped': (f) => {
    const where = [text(f.d.store), text(f.d.territory)].filter((x) => x !== undefined).join(', ');
    return {
      title: ['rating.dropped.title', { app: f.app, to: f.n(f.d.to) }],
      body: [
        where ? 'rating.dropped.body' : 'rating.dropped.body.noWhere',
        {
          app: f.app,
          where,
          from: f.n(f.d.from),
          to: f.n(f.d.to),
          days: f.unit(f.d.windowDays, 'day'),
        },
      ],
    };
  },
  'store.sync_failed': (f) => ({
    title: ['store.sync_failed.title', { app: f.app }],
    body: ['store.sync_failed.body', { app: f.app }],
  }),
  'credential.invalid': (f) => {
    const kind = text(f.d.kind);
    const label = text(f.d.label);
    const id = f.word(f.d.credentialId);
    return {
      title: kind
        ? ['credential.invalid.title', { kind: credentialKindName(kind) }]
        : ['credential.invalid.title.noKind'],
      body: label
        ? ['credential.invalid.body', { label, id }]
        : ['credential.invalid.body.noLabel', { id }],
    };
  },
  'listing.drift': (f) => {
    const count = number(f.d.fields);
    return {
      title: ['listing.drift.title', { app: f.app }],
      body:
        count === undefined
          ? ['listing.drift.body.some', { app: f.app }]
          : ['listing.drift.body', { app: f.app, count }],
    };
  },
  'listing.read_failing': (f) => {
    const count = number(f.d.failures);
    return {
      title: ['listing.read_failing.title', { app: f.app }],
      body:
        count === undefined
          ? ['listing.read_failing.body.several', { app: f.app }]
          : ['listing.read_failing.body', { app: f.app, count }],
    };
  },
  'ci.run_failed': (f) => {
    const conclusion = text(f.d.conclusion) ?? 'failure';
    const run = text(f.d.runId) ?? '?';
    const kind = conclusion === 'failure' ? 'failure' : conclusion === 'timed_out' ? 'timedOut' : '';
    return {
      title: f.d.appId
        ? ['ci.run_failed.title', { app: f.app }]
        : ['ci.run_failed.title.noApp'],
      body: kind
        ? [`ci.run_failed.body.${kind}`, { run }]
        : ['ci.run_failed.body', { run, conclusion }],
    };
  },
  'changeset.failed': (f) => ({
    title: ['changeset.failed.title'],
    body: [
      'changeset.failed.body',
      { id: text(f.d.changeSetId) ?? '?', reason: f.word(f.d.reason) },
    ],
  }),
  'pending.stale': (f) => {
    const count = number(f.d.count);
    return {
      title: ['pending.stale.title', { app: f.app, days: f.unit(f.d.days, 'day') }],
      body:
        count === undefined
          ? ['pending.stale.body.some', { app: f.app, date: f.date(f.d.oldest) }]
          : ['pending.stale.body', { app: f.app, date: f.date(f.d.oldest), count }],
    };
  },
  'analytics.sync_failing': (f) => {
    const count = number(f.d.failures);
    return {
      title: ['analytics.sync_failing.title', { app: f.app }],
      body:
        count === undefined
          ? ['analytics.sync_failing.body.several', { app: f.app, code: f.word(f.d.code) }]
          : ['analytics.sync_failing.body', { app: f.app, code: f.word(f.d.code), count }],
    };
  },
  'aso.rank_dropped': (f) => {
    const rank = (v: unknown) => (number(v) === undefined ? f.t('alerts:common.unranked') : f.n(v));
    const country = text(f.d.country);
    return {
      title: ['aso.rank_dropped.title', { app: f.app }],
      body: [
        country ? 'aso.rank_dropped.body' : 'aso.rank_dropped.body.noCountry',
        { keyword: text(f.d.keywordId) ?? '?', country, from: rank(f.d.from), to: rank(f.d.to) },
      ],
    };
  },
  'aso.competitor_changed': (f) => ({
    title: ['aso.competitor_changed.title', { app: f.app }],
    body: ['aso.competitor_changed.body', { id: text(f.d.competitorId) ?? '?' }],
  }),
  'ai.suggestion_ready': (f) => ({
    title: ['ai.suggestion_ready.title', { app: f.app }],
    body: [
      'ai.suggestion_ready.body',
      { id: text(f.d.suggestionId) ?? '?', task: text(f.d.task) ?? f.t('alerts:common.task') },
    ],
  }),
  'security.stepup_failed': (f) => {
    const count = number(f.d.failedCount);
    const p = {
      user: text(f.d.userId) ?? '?',
      action: text(f.d.action) ?? '?',
      reason: f.word(f.d.reason),
    };
    return {
      title: ['security.stepup_failed.title'],
      body:
        count === undefined
          ? ['security.stepup_failed.body.several', p]
          : ['security.stepup_failed.body', { ...p, count }],
    };
  },
  'security.recovery_used': (f) => {
    const remaining = number(f.d.remaining);
    const user = text(f.d.userId) ?? '?';
    return {
      title: ['security.recovery_used.title'],
      body:
        remaining === undefined
          ? ['security.recovery_used.body', { user }]
          : ['security.recovery_used.body.remaining', { user, count: remaining }],
    };
  },
  'security.token_created': (f) => ({
    title: ['security.token_created.title', { name: text(f.d.name) ?? '?' }],
    body: [
      'security.token_created.body',
      {
        id: text(f.d.tokenId) ?? '?',
        role: f.role(f.d.role),
        by: text(f.d.createdBy) ?? '?',
      },
    ],
  }),
  'security.member_added': (f) => ({
    title: ['security.member_added.title'],
    body: [
      'security.member_added.body',
      { user: text(f.d.userId) ?? '?', role: f.role(f.d.role ?? 'member') },
    ],
  }),
  'system.smtp_failing': (f) => {
    const count = number(f.d.failures);
    return {
      title: ['system.smtp_failing.title'],
      body:
        count === undefined
          ? ['system.smtp_failing.body.several', { code: f.word(f.d.code) }]
          : ['system.smtp_failing.body', { code: f.word(f.d.code), count }],
    };
  },
  'test.alert': (f) => {
    const channel = text(f.d.channel);
    const known = channel && ['in_app', 'email', 'desktop', 'webhook'].includes(channel);
    return {
      title: ['test.alert.title'],
      body: [known ? `test.alert.body.${channel}` : 'test.alert.body'],
    };
  },
};

/** The product behind a credential kind: brand names are not translated; a kind this build does not know stays as written. */
function credentialKindName(kind: string): string {
  const names: Record<string, string> = {
    app_store_connect: 'App Store Connect',
    google_play: 'Google Play',
    github_app: 'GitHub',
    github_token: 'GitHub',
    translate_google: 'Google Translate',
    translate_deepl: 'DeepL',
    translate_azure: 'Azure Translator',
    translate_libretranslate: 'LibreTranslate',
    ai_anthropic: 'Anthropic',
    ai_openai: 'OpenAI',
    expo: 'Expo',
  };
  return names[kind] ?? kind;
}

/** Whether the type has sentences in the catalog. */
export const hasAlertText = (typeId: string): boolean => typeId in specs;

/** The title and body of an alert in `locale`, or undefined for a type with no catalog entry. */
export function alertText(
  typeId: string,
  data: AlertData,
  locale: string = SOURCE_LOCALE,
): { title: string; body: string } | undefined {
  const spec = specs[typeId];
  if (!spec) return undefined;
  const t = translator(locale);
  const { title, body } = spec(formatter(t, data));
  const say = ([key, params]: Msg) => t(`alerts:${camelKey(key)}`, params);
  return { title: say(title).slice(0, 300), body: say(body).slice(0, 2000) };
}
