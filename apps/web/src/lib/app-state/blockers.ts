import { deviceLabel, RECOMPUTABLE_CODES, reconcileBlockers, type SubmitBlocker } from '@kiln/core';
import { formatRelativeTime } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import type { LastPublish, RunBlocker } from '../pending.ts';
import { type BlockerLine, blockerLines, submitBlockedOnly } from '../publish-failure.ts';

/**
 * What blocks the submit of a draft that a publish pushed: the blockers the RUN kept (history: what was true when it ran) held against
 * a CURRENT reading of the store (`GET /apps/:id/publish/readiness`, judged by the pure rules of `@kiln/core`). A blocker is a claim about
 * one moment, so the run's list is never shown as current once a newer reading exists: it is kept apart as history, and the card, the
 * failure block and the top bar say what the reading says. Pure: the clock is `now`. Written for the ES2017 web build.
 *
 * `unverified`: no reading newer than the run (not read yet, the person may not read the store, the server said no): the run's blockers
 * are shown as they were, labelled with their age. `blocked`: the reading still has blockers: only those are current. `ready`: the
 * reading has none, so everything that blocked the submit is fixed (the submit checks the store once more when it runs).
 */

/** One reading of the store: what the server answered. */
export type ReadinessReading = {
  ready: boolean;
  blockers: readonly SubmitBlocker[];
  unknown: readonly string[];
  versionString: string | null;
  /** When the store was read (epoch ms). */
  storeReadAt: number;
};

/** The fact the model derives from: the last reading of an app, whether one is on its way, and why the last one failed. */
export type ReadinessFact = {
  reading: ReadinessReading | null;
  checking: boolean;
  error: string | null;
};

export type BlockersState = 'unverified' | 'blocked' | 'ready';

export type BlockersView = {
  state: BlockersState;
  /** What blocks now (state `blocked`); empty otherwise. */
  current: BlockerLine[];
  /** HISTORY: what the run recorded when it ran, whatever has been fixed since. */
  run: BlockerLine[];
  /** Of the run's blockers, those that no longer hold. */
  resolved: BlockerLine[];
  /**
   * A submit the store refused: the reasons it gave that Kiln cannot read back (`RECOMPUTABLE_CODES`: a copyright, the price, the
   * privacy labels, a reason it has no rule for). They stand until the person fixes them in the store, whatever the reading says.
   */
  unchecked: BlockerLine[];
  /** When the run ended, and when the store was last read for the current list (null: not read). */
  runAt: number;
  readAt: number | null;
  /** "From the last publish, 12 minutes ago" / "Store images read 1 minute ago", ready to draw. */
  runLabel: string;
  readLabel: string;
  /** "Still 12 iPad 13" / 12.9" screenshots: remove 2" / "All clear" / "" (nothing read). */
  summary: string;
  checking: boolean;
  error: string | null;
  /** The version a submit would send, when the reading knows it. */
  versionString: string | null;
};

const storeOf = (platform: LastPublish['platform']): 'app_store' | 'google_play' =>
  platform === 'android' ? 'google_play' : 'app_store';

/** A blocker of a reading in the shape a run keeps it (only what is shown). */
const runBlockerOf = (b: SubmitBlocker): RunBlocker => ({
  code: b.code,
  message: b.message,
  ...(b.locale !== undefined ? { locale: b.locale } : {}),
  ...(b.item !== undefined ? { item: b.item } : {}),
  ...(b.params !== undefined ? { params: b.params } : {}),
});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One sentence for the current list: the one set that is over ("Still 12 ... screenshots: remove 2"), else how many blockers stand. */
function summaryOf(platform: LastPublish['platform'], current: readonly SubmitBlocker[]): string {
  if (current.length === 0) return t('state:blockers.allClear');
  const only = current.length === 1 ? current[0] : undefined;
  const count = num(only?.params?.count);
  const max = num(only?.params?.max);
  const device = only?.params?.device;
  if (only !== undefined && count !== null && max !== null && typeof device === 'string')
    return t('state:blockers.stillOver', {
      count,
      device: deviceLabel(storeOf(platform), device),
      remove: Math.max(0, count - max),
    });
  return t('state:blockers.still', { count: current.length });
}

/** The blockers of a run that was only blocked at its submit, against the last reading; null for a run that is not that. */
export function blockersViewOf(
  run: LastPublish,
  fact: ReadinessFact | null | undefined,
  now: number,
): BlockersView | null {
  if (!submitBlockedOnly(run)) return null;
  const step = run.results.find(
    (r) =>
      (r.status === 'skipped' && r.reason === 'blocked') ||
      (r.status === 'failed' && (r.blockers ?? []).length > 0),
  );
  const raw: RunBlocker[] = step?.blockers ?? [];
  const runLines = blockerLines({ blockers: raw });
  // A reading made before the run ended says nothing about what the run left.
  const reading =
    fact?.reading != null && fact.reading.storeReadAt >= run.finishedAt ? fact.reading : null;
  const unchecked =
    step?.status === 'failed'
      ? runLines.filter((b) => RECOMPUTABLE_CODES.indexOf(b.code) < 0)
      : [];
  const base = {
    run: runLines,
    unchecked,
    runAt: run.finishedAt,
    runLabel: t('state:blockers.fromRun', { ago: formatRelativeTime(run.finishedAt, { now }) }),
    checking: fact?.checking === true,
    error: fact?.error ?? null,
  };
  if (reading === null)
    return {
      ...base,
      state: 'unverified',
      current: [],
      resolved: [],
      readAt: null,
      readLabel: '',
      summary: '',
      versionString: fact?.reading?.versionString ?? null,
    };
  const rec = reconcileBlockers(
    raw.filter((b) => RECOMPUTABLE_CODES.indexOf(b.code) >= 0),
    reading.blockers,
  );
  return {
    ...base,
    state: reading.blockers.length === 0 ? 'ready' : 'blocked',
    current: blockerLines({ blockers: reading.blockers.map(runBlockerOf) }),
    resolved: blockerLines({ blockers: rec.resolved }),
    readAt: reading.storeReadAt,
    readLabel: t('state:blockers.read', { ago: formatRelativeTime(reading.storeReadAt, { now }) }),
    summary: summaryOf(run.platform, reading.blockers),
    versionString: reading.versionString,
  };
}
