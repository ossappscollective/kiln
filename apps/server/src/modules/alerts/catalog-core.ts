import type { Action } from '@mrm/core';
import type { EventType } from '../../services/event-types.ts';

/**
 * The alert catalog, part 1: the types, the helpers and the release definitions (docs/alerts.md, docs/adr/0022-alerts.md): every condition somebody can be told about, as data. Pure: no
 * database, no clock, no network, so the screen, the docs and the tests all read the same table.
 *
 * An alert type comes from an event (`source.kind: 'event'`: the event log is the one place every emitter writes to, see
 * `services/alerts.ts` for the hook) or from state that no event announces (`source.kind: 'state'`: found by the evaluator in
 * `services/alert-evaluator.ts`). Titles and bodies are templates over ids, names and numbers; they are never given a credential,
 * a token, review text, a store answer or a person's address.
 */

export const alertSeverities = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];
export const severityRank: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
export const isSeverity = (v: unknown): v is AlertSeverity =>
  typeof v === 'string' && (alertSeverities as readonly string[]).includes(v);

/** `webhook` is workspace wide (the webhook endpoints decide who hears it); the others are per person. */
export const alertChannels = ['in_app', 'email', 'desktop', 'webhook'] as const;
export type AlertChannel = (typeof alertChannels)[number];
export const personalChannels = ['in_app', 'email', 'desktop'] as const;
export type PersonalChannel = (typeof personalChannels)[number];
export const isChannel = (v: unknown): v is AlertChannel =>
  typeof v === 'string' && (alertChannels as readonly string[]).includes(v);
export const isPersonalChannel = (v: unknown): v is PersonalChannel =>
  typeof v === 'string' && (personalChannels as readonly string[]).includes(v);

export const alertGroups = [
  'releases',
  'reviews',
  'store',
  'builds',
  'analytics',
  'aso',
  'ai',
  'security',
  'system',
] as const;
export type AlertGroup = (typeof alertGroups)[number];
export const alertGroupLabels: Record<AlertGroup, string> = {
  releases: 'Releases and rollouts',
  reviews: 'Reviews and ratings',
  store: 'Store connection and listing',
  builds: 'Builds and changes',
  analytics: 'Analytics',
  aso: 'ASO',
  ai: 'AI assistant',
  security: 'Security and access',
  system: 'System',
};

/** Plain values only: ids, names, numbers. Nothing here may be a secret (see `redactAlertData`). */
export type AlertData = Record<string, string | number | boolean | null>;

export type AlertParamDef = {
  default: number;
  min: number;
  max: number;
  unit: string;
  label: string;
};

export type EventLike = {
  type: string;
  workspaceId: string;
  subject: { appId?: string; repositoryId?: string; releaseId?: string };
  payload: Record<string, unknown>;
  createdAt: number;
};

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export type AlertDef<Id extends string = string> = {
  id: Id;
  group: AlertGroup;
  label: string;
  /** One sentence for the matrix: when this alert fires. */
  description: string;
  severity: AlertSeverity;
  scope: 'workspace' | 'app';
  /** Where it goes with no workspace rule and no personal choice. */
  defaultChannels: readonly AlertChannel[];
  /** The channels this type may ever use (an alert about mail failing must not travel by mail). */
  allowedChannels: readonly AlertChannel[];
  /** Who is told: people whose role has this action. */
  audience: Action;
  source:
    | { kind: 'event'; events: readonly EventType[] }
    | { kind: 'state'; check: string }
    | { kind: 'internal' };
  /** The key under which repeats collapse; this is its template. */
  dedupe: string;
  dedupeKey: (d: AlertData) => string;
  dedupeWindowMs: number;
  /** Alerts of this type one workspace may raise per hour before repeats are only counted. */
  maxPerHour: number;
  params: Record<string, AlertParamDef>;
  title: (d: AlertData) => string;
  body: (d: AlertData) => string;
  /** For event sources: the data of the alert, or null when this event is not worth one. */
  fromEvent?: (e: EventLike, params: Record<string, number>) => AlertData | null;
};

export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
export const app = (d: AlertData) => String(d.appName ?? d.appId ?? 'An app');
export const ver = (d: AlertData) => (d.version ? ` ${String(d.version)}` : '');
export const everyone = [
  'in_app',
  'email',
  'desktop',
  'webhook',
] as const satisfies readonly AlertChannel[];
export const noEmail = ['in_app', 'desktop', 'webhook'] as const satisfies readonly AlertChannel[];
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const statusData = (e: EventLike): AlertData => {
  const p = e.payload;
  return {
    appId: e.subject.appId ?? null,
    version: str(p.version),
    track: str(p.track),
    build: str(p.build),
    from: str(p.from),
    to: str(p.to),
  };
};

export function def<Id extends string>(d: AlertDef<Id>): AlertDef<Id> {
  return d;
}

const isStatus = (e: EventLike, ...to: string[]) =>
  e.type === 'app.release.status_changed' && to.includes(String(e.payload.to));

export const releaseDefs = [
  def({
    id: 'release.rejected',
    group: 'releases',
    label: 'Store review rejected a version',
    description: 'A sync saw a version move to rejected (it was in review).',
    severity: 'critical',
    scope: 'app',
    defaultChannels: ['in_app', 'email', 'desktop', 'webhook'],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['app.release.status_changed'] },
    dedupe: 'release.rejected:{appId}:{version}:{track}',
    dedupeKey: (d) => `release.rejected:${d.appId}:${d.version}:${d.track ?? ''}`,
    dedupeWindowMs: 7 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} was rejected in store review`,
    body: (d) =>
      `The store moved${ver(d)} of ${app(d)} from ${String(d.from ?? 'unknown')} to rejected. Read the reviewer's message in the store console, fix it, and submit again.`,
    fromEvent: (e) => (isStatus(e, 'rejected') ? statusData(e) : null),
  }),
  def({
    id: 'release.approved',
    group: 'releases',
    label: 'A version was approved',
    description: 'A sync saw a version move to approved.',
    severity: 'info',
    scope: 'app',
    defaultChannels: ['in_app', 'desktop'],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['app.release.status_changed'] },
    dedupe: 'release.approved:{appId}:{version}:{track}',
    dedupeKey: (d) => `release.approved:${d.appId}:${d.version}:${d.track ?? ''}`,
    dedupeWindowMs: 7 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} was approved`,
    body: (d) => `The store approved${ver(d)} of ${app(d)}. It can be released.`,
    fromEvent: (e) => (isStatus(e, 'approved') ? statusData(e) : null),
  }),
  def({
    id: 'release.live',
    group: 'releases',
    label: 'A version is live or rolling out',
    description: 'A sync saw a version move to live or rolling out (ready for sale).',
    severity: 'info',
    scope: 'app',
    defaultChannels: ['in_app'],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['app.release.status_changed'] },
    dedupe: 'release.live:{appId}:{version}:{track}:{to}',
    dedupeKey: (d) => `release.live:${d.appId}:${d.version}:${d.track ?? ''}:${d.to}`,
    dedupeWindowMs: 7 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} is ${d.to === 'rolling_out' ? 'rolling out' : 'live'}`,
    body: (d) =>
      `The store reports${ver(d)} of ${app(d)} as ${d.to === 'rolling_out' ? 'rolling out' : 'live'}.`,
    fromEvent: (e) => (isStatus(e, 'live', 'rolling_out') ? statusData(e) : null),
  }),
  def({
    id: 'release.in_review',
    group: 'releases',
    label: 'A version entered store review',
    description: 'A sync saw a version move to in review.',
    severity: 'info',
    scope: 'app',
    defaultChannels: [],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['app.release.status_changed'] },
    dedupe: 'release.in_review:{appId}:{version}:{track}',
    dedupeKey: (d) => `release.in_review:${d.appId}:${d.version}:${d.track ?? ''}`,
    dedupeWindowMs: 7 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} is in store review`,
    body: (d) => `${app(d)}${ver(d)} moved from ${String(d.from ?? 'unknown')} to in review.`,
    fromEvent: (e) => (isStatus(e, 'in_review') ? statusData(e) : null),
  }),
  def({
    id: 'release.halted',
    group: 'releases',
    label: 'A rollout was paused or halted',
    description: 'A rollout was halted from this tool, or a sync saw a version move to halted.',
    severity: 'critical',
    scope: 'app',
    defaultChannels: ['in_app', 'email', 'desktop', 'webhook'],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['release.rollout_changed', 'app.release.status_changed'] },
    dedupe: 'release.halted:{appId}:{version|track}',
    dedupeKey: (d) => `release.halted:${d.appId}:${d.version ?? d.track ?? ''}`,
    dedupeWindowMs: 3 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `Rollout of ${app(d)}${ver(d)} was halted`,
    body: (d) =>
      `The rollout of ${app(d)}${ver(d)}${d.track ? ` on track ${String(d.track)}` : ''} is halted. Users get no further expansion until it is resumed.`,
    fromEvent: (e) => {
      if (e.type === 'release.rollout_changed' && e.payload.action === 'halt') {
        return {
          appId: e.subject.appId ?? null,
          version: str(e.payload.version),
          track: str(e.payload.track),
        };
      }
      return isStatus(e, 'halted') ? statusData(e) : null;
    },
  }),
  def({
    id: 'release.stalled',
    group: 'releases',
    label: 'A release has stalled',
    description: 'A release plan step has not moved for longer than the workspace limit.',
    severity: 'warning',
    scope: 'app',
    defaultChannels: ['in_app', 'desktop'],
    allowedChannels: everyone,
    audience: 'apps.read',
    source: { kind: 'event', events: ['release.stalled'] },
    dedupe: 'release.stalled:{appId}:{episode}',
    dedupeKey: (d) => `release.stalled:${d.appId}:${d.episode ?? d.version ?? ''}`,
    dedupeWindowMs: 3 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} has stalled${d.step ? ` at ${String(d.step)}` : ''}`,
    body: (d) =>
      `${app(d)}${ver(d)} has not moved on from ${String(d.step ?? 'its current step')} for a while. Open the release to see what it is waiting for.`,
    fromEvent: (e) => ({
      appId: e.subject.appId ?? null,
      appName: str(e.payload.appName),
      step: str(e.payload.step),
      episode: str(e.payload.episode),
      version: str(e.payload.version),
    }),
  }),
  def({
    id: 'plan.deadline_overdue',
    group: 'releases',
    label: 'A release plan is past its target day',
    description: 'A release plan target date has passed.',
    severity: 'warning',
    scope: 'app',
    defaultChannels: ['in_app', 'email'],
    allowedChannels: everyone,
    audience: 'plans.read',
    source: { kind: 'event', events: ['plan.deadline_overdue'] },
    dedupe: 'plan.deadline_overdue:{planId}',
    dedupeKey: (d) => `plan.deadline_overdue:${d.planId}`,
    dedupeWindowMs: 3 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} is ${d.daysOverdue ?? 'some'} day(s) past its target date`,
    body: (d) =>
      `The release plan for ${app(d)}${ver(d)} had a target date of ${String(d.targetDate ?? 'unknown')}. ${d.openRequiredItems ?? 0} required checklist item(s) are still open.`,
    fromEvent: (e) => ({
      appId: e.subject.appId ?? null,
      appName: str(e.payload.appName),
      planId: str(e.payload.planId),
      version: str(e.payload.version),
      targetDate: str(e.payload.targetDate),
      daysOverdue: num(e.payload.daysOverdue),
      openRequiredItems: num(e.payload.openRequiredItems),
    }),
  }),
  def({
    id: 'plan.deadline_due_soon',
    group: 'releases',
    label: 'A release plan target day is close',
    description: 'A release plan target date is within the reminder lead time.',
    severity: 'info',
    scope: 'app',
    defaultChannels: ['in_app'],
    allowedChannels: everyone,
    audience: 'plans.read',
    source: { kind: 'event', events: ['plan.deadline_due_soon'] },
    dedupe: 'plan.deadline_due_soon:{planId}',
    dedupeKey: (d) => `plan.deadline_due_soon:${d.planId}`,
    dedupeWindowMs: 3 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `${app(d)}${ver(d)} is due soon`,
    body: (d) =>
      `The release plan for ${app(d)}${ver(d)} has a target date of ${String(d.targetDate ?? 'unknown')}${d.blocked ? ' and is blocked' : ''}.`,
    fromEvent: (e) => ({
      appId: e.subject.appId ?? null,
      appName: str(e.payload.appName),
      planId: str(e.payload.planId),
      version: str(e.payload.version),
      targetDate: str(e.payload.targetDate),
      blocked: e.payload.blocked === true,
    }),
  }),
  def({
    id: 'plan.rollout_step_due',
    group: 'releases',
    label: 'A planned rollout step is due',
    description: 'The time of a planned rollout step has passed and the step is not done.',
    severity: 'info',
    scope: 'app',
    defaultChannels: ['in_app', 'desktop'],
    allowedChannels: everyone,
    audience: 'plans.read',
    source: { kind: 'event', events: ['plan.rollout_step_due'] },
    dedupe: 'plan.rollout_step_due:{stepId}',
    dedupeKey: (d) => `plan.rollout_step_due:${d.stepId}`,
    dedupeWindowMs: 3 * DAY,
    maxPerHour: 20,
    params: {},
    title: (d) => `Rollout step ${d.index ?? ''} of ${d.total ?? ''} for ${app(d)}${ver(d)} is due`,
    body: (d) =>
      `The planned step to ${d.percent ?? '?'}% for ${app(d)}${ver(d)} is ${d.minutesLate ?? 0} minute(s) late. This tool never changes a rollout by itself; do it from the app.`,
    fromEvent: (e) => ({
      appId: e.subject.appId ?? null,
      appName: str(e.payload.appName),
      planId: str(e.payload.planId),
      stepId: str(e.payload.stepId),
      version: str(e.payload.version),
      index: num(e.payload.index),
      total: num(e.payload.total),
      percent: num(e.payload.percent),
      minutesLate: num(e.payload.minutesLate),
    }),
  }),
] as const;

export const defaultParams = (d: Pick<AlertDef, 'params'>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(d.params)) out[k] = p.default;
  return out;
};
