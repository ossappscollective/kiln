import {
  type AlertData,
  type AlertDef,
  defaultParams,
  type EventLike,
  releaseDefs,
} from './catalog-core.ts';
import { moreDefs } from './catalog-more.ts';
import type { EventType } from '../../services/event-types.ts';

/**
 * The alert catalog (docs/alerts.md, docs/adr/0022-alerts.md): every condition somebody can be told about, as data. Pure: no
 * database, no clock, no network, so the screen, the docs and the tests all read the same table. The definitions live in
 * alert-catalog-core.ts (types, helpers, releases) and alert-catalog-more.ts (the rest); this file puts them together.
 */
export * from './catalog-core.ts';

const defs = [...releaseDefs, ...moreDefs] as const;

export type AlertTypeId = (typeof defs)[number]['id'];
export const alertCatalog: readonly AlertDef<AlertTypeId>[] = defs;
export const alertTypeIds: readonly AlertTypeId[] = alertCatalog.map((d) => d.id);
const byId = new Map<string, AlertDef<AlertTypeId>>(alertCatalog.map((d) => [d.id, d]));
export const alertDef = (id: string): AlertDef<AlertTypeId> | undefined => byId.get(id);
export const isAlertType = (id: unknown): id is AlertTypeId =>
  typeof id === 'string' && byId.has(id);
/** The types a person can configure: everything but the internal test. */
export const configurableAlertTypes: readonly AlertDef<AlertTypeId>[] = alertCatalog.filter(
  (d) => d.source.kind !== 'internal',
);

/**
 * Events that never raise an alert, with the reason. A test checks that every event type is either named by an alert type or
 * listed here, so adding an event forces a decision.
 */
export const notAlertable: Partial<Record<EventType, string>> = {
  'app.synced':
    'Routine: the sync result is already shown, and a failure is the state alert store.sync_failed.',
  'changeset.created': 'A person did it just now; they know.',
  'changeset.approved': 'A person did it just now; they know.',
  'changeset.applied': 'Success of an action a person started.',
  'plan.rollout_step_done': 'A person did it just now; they know.',
  'plan.rollout_step_skipped': 'A person did it just now; they know.',
  'plan.rollout_step_reopened': 'A person did it just now; they know.',
  'review.reply_sent': 'Success of an action a person started.',
  'listing.draft_pushed': 'Success of an action a person started.',
  'listing.submitted': 'Success of an action a person started.',
  'release.started': 'Success of an action a person started.',
  'pending.published': 'Success of an action a person started.',
  'ci.run_started': 'Routine; only the failure is news.',
  'assets.pulled': 'Success of an action a person started.',
  'analytics.synced': 'Routine; repeated failure is the state alert analytics.sync_failing.',
  'stepup.verified': 'Routine; only failures and recovery codes are news.',
  'auth.second_factor_failed':
    'One wrong sign-in code is routine and the event has no failure count; the alert for repeated failed confirmations is security.stepup_failed.',
  'alert.raised': 'An alert about an alert would loop.',
};

/** The alert types that listen to each event type, for the hook. */
export const eventAlertTypes: ReadonlyMap<string, readonly AlertDef<AlertTypeId>[]> = (() => {
  const map = new Map<string, AlertDef<AlertTypeId>[]>();
  for (const d of alertCatalog) {
    if (d.source.kind !== 'event') continue;
    for (const type of d.source.events) map.set(type, [...(map.get(type) ?? []), d]);
  }
  return map;
})();

/** Defaults for a type with the workspace's own values laid over them, each kept inside its range. */
export function resolveParams(
  d: Pick<AlertDef, 'params'>,
  stored: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const out = defaultParams(d);
  for (const [k, p] of Object.entries(d.params)) {
    const v = stored?.[k];
    if (typeof v === 'number' && Number.isFinite(v))
      out[k] = Math.min(p.max, Math.max(p.min, Math.trunc(v)));
  }
  return out;
}

/** The alerts one event gives rise to (zero, one or several types), with their data. Pure. */
export function alertsFromEvent(
  event: EventLike,
  paramsOf: (def: AlertDef<AlertTypeId>) => Record<string, number> = (d) => defaultParams(d),
): { def: AlertDef<AlertTypeId>; data: AlertData }[] {
  const out: { def: AlertDef<AlertTypeId>; data: AlertData }[] = [];
  for (const d of eventAlertTypes.get(event.type) ?? []) {
    const data = d.fromEvent?.(event, paramsOf(d)) ?? null;
    if (data) out.push({ def: d, data });
  }
  return out;
}

const SECRETY =
  /secret|token(?!Id)|password|passwd|ciphertext|authorization|private_?key|api_?key/i;
const MAX_TEXT = 300;

/** Defence in depth: data holds plain scalars only, secret-looking keys are dropped, long text is cut. */
export function redactAlertData(data: Record<string, unknown>): AlertData {
  const out: AlertData = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRETY.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_TEXT);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}
