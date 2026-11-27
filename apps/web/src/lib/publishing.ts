import {
  type Platform,
  PUBLISH_POLL_HIDDEN_MS,
  PUBLISH_POLL_MAX_MS,
  PUBLISH_POLL_VISIBLE_MS,
  PUBLISH_SILENT_AFTER_MS,
  PUBLISH_STUCK_AFTER_MS,
  platformMeta,
} from '@kiln/core';
import { appAddress, type PlatformScope } from './app-scope.ts';
import { timeAgo } from './format.ts';
import { t } from './i18n/t.ts';
import { type LastPublish, type PublishStepType, STEP_NAME } from './pending.ts';
import { elapsedText, PUBLISH_WAIT_LIMIT_MS } from './publish-run.ts';

/**
 * A publish that runs on the server right now (docs/api/pending.md "Publishing now"), pure: the wire types of
 * `GET /pending/publishing` and of the `publishing` field of the pending view, what the status row says (which step of how many, since
 * when), why a button is off while it runs, when the screens poll, and the loader that keeps ONE answer for the workspace in view. No
 * DOM and no framework: `publishing-store.svelte.ts` wraps `createPublishingLoader`, so every screen agrees.
 */

/** What the running step says it is doing: a fixed phase word and two counts (never a text of the store). */
export type PublishingDetail = {
  phase: 'writing_texts' | 'uploading_images' | 'processing_images' | 'placing_images';
  done: number | null;
  total: number | null;
  at: number;
};

export type Publishing = {
  startedAt: number;
  /** The steps the batch runs, in order (empty for a claim of an older server: the screens then say only that a publish runs). */
  steps: PublishStepType[];
  /** The step that runs now; null before the first one starts and between steps. */
  currentStep: PublishStepType | null;
  stepStartedAt: number | null;
  by: { id: string; name: string | null } | null;
  /** The last sign of life of the server process that runs it (absent from an older server). */
  heartbeatAt?: number | undefined;
  /** What the running step is doing, or null (absent from an older server). */
  detail?: PublishingDetail | null | undefined;
  /** How many steps ended applied so far. */
  stepsDone?: number | undefined;
  /** The server lets a person end this claim now: silent for a minute, or running for longer than any batch should. */
  interruptible?: boolean | undefined;
};

export type PublishingList = {
  apps: { appId: string; publishing: Publishing }[];
  /**
   * The apps whose latest publish did not complete and was not dismissed, with the reason (absent from an older server: what the
   * screens hold is then left as it is).
   */
  lastPublish?: { appId: string; lastPublish: LastPublish }[] | undefined;
  generatedAt: number;
};

/** A publish this browser started and the server has not confirmed yet (it is shown at once; the first read that sees it confirms it). */
export type PublishingEntry = Publishing & { optimistic?: boolean };

// ---------------------------------------------------------------------------------------------
// What it says

export type StepProgress = {
  /** 1-based position of the running step, or null when none runs (or the steps are not known). */
  index: number | null;
  total: number;
  step: PublishStepType | null;
  /** The name of the running step ("Push the draft"), null when none runs. */
  name: string | null;
};

/** Which step is current: the running one, with its place in the list. */
export function stepProgress(p: Pick<Publishing, 'steps' | 'currentStep'>): StepProgress {
  const total = p.steps.length;
  if (p.currentStep === null) return { index: null, total, step: null, name: null };
  const at = p.steps.indexOf(p.currentStep);
  return {
    index: at >= 0 ? at + 1 : null,
    total,
    step: p.currentStep,
    name: STEP_NAME[p.currentStep],
  };
}

/** `Publishing to Google Play…` */
export const headlineText = (platform: Platform): string =>
  t('publish:publishing.headline', { store: platformMeta(platform).storeName });

/**
 * The second line of the status row: `started 3 minutes ago · step 1 of 2: Push the draft`. Without a running step it says how many steps
 * there are; without a list of steps, only when it started.
 */
export function detailText(p: Publishing, now: number): string {
  const parts = [t('publish:publishing.started', { ago: timeAgo(p.startedAt, now) })];
  const at = stepProgress(p);
  if (at.name !== null && at.index !== null)
    parts.push(t('publish:publishing.step', { index: at.index, total: at.total, name: at.name }));
  else if (at.name !== null) parts.push(at.name);
  else if (at.total > 0) parts.push(t('publish:publishing.steps', { count: at.total }));
  return parts.join(' · ');
}

/** The second line's progress of a long step: `Uploading screenshots: 12 of 40`; null when the step says nothing (or not with numbers). */
export function progressText(p: Pick<Publishing, 'detail' | 'currentStep'>): string | null {
  const d = p.detail;
  if (p.currentStep === null || d === null || d === undefined) return null;
  const done = d.done ?? 0;
  const total = d.total ?? 0;
  switch (d.phase) {
    case 'writing_texts':
      return t('publish:publishing.detail.writingTexts', {
        current: Math.min(done + 1, Math.max(total, 1)),
        total,
      });
    case 'uploading_images':
      return t('publish:publishing.detail.uploading', { done, total });
    case 'processing_images':
      return t('publish:publishing.detail.processing', { done, total });
    case 'placing_images':
      return t('publish:publishing.detail.placing');
    default:
      return null;
  }
}

/**
 * After this long without a sign of life from the server the row says so (a beat is due every `PUBLISH_HEARTBEAT_MS`). The SAME value as
 * the server's `PUBLISH_SILENT_AFTER_MS` (`@kiln/core` timings): it used to be 45 seconds here and 60 there.
 */
export const QUIET_AFTER_MS = PUBLISH_SILENT_AFTER_MS;

/** How long the server has been silent, when that is worth saying (a server that does not send a beat: nothing to say). */
export const quietFor = (p: Pick<Publishing, 'heartbeatAt'>, now: number): number | null =>
  p.heartbeatAt === undefined || now - p.heartbeatAt < QUIET_AFTER_MS ? null : now - p.heartbeatAt;

/** The line for a server that has gone quiet: `The server has not reported for 2:10.` */
export const quietText = (p: Pick<Publishing, 'heartbeatAt'>, now: number): string | null => {
  const ms = quietFor(p, now);
  return ms === null ? null : t('publish:publishing.quiet', { time: elapsedText(ms) });
};

/** A publish that has run for longer than any batch is meant to (a step is cut at 8 minutes): the row says it looks stuck. */
export const STUCK_AFTER_MS = PUBLISH_STUCK_AFTER_MS;
export const looksStuck = (p: Pick<Publishing, 'startedAt'>, now: number): boolean =>
  now - p.startedAt >= STUCK_AFTER_MS;

/**
 * Whether the server ended a publish without an answer (it restarted, or the request was lost): the latest kept failure is a run that is
 * not the one that was there when this publish began (`before`) and whose step failed with `interrupted`. The dialog that still waits for
 * its request stops waiting then.
 */
export const endedByServer = (run: LastPublish | null, before: string): boolean =>
  run !== null && run.id !== before && run.results.some((r) => r.error === 'interrupted');

/** The time the publish has been running, as `3:12` (never negative). */
export const elapsedOf = (p: Pick<Publishing, 'startedAt'>, now: number): string =>
  elapsedText(now - p.startedAt);

/** Who started it, when that is somebody else's name worth saying; null otherwise. */
export const byText = (p: Publishing, me: string | null): string | null =>
  p.by?.name && p.by.id !== me ? t('publish:publishing.by', { name: p.by.name }) : null;

/** Why a button that would publish, release, submit or change something for this app is off while the publish runs (a tooltip, a note). */
export const disabledReason = (p: Publishing, now: number): string =>
  t('publish:publishing.disabledReason', { ago: timeAgo(p.startedAt, now) });

/** The row of a pending item that is being written by the publish. */
export const beingPublishedText = (): string => t('publish:publishing.rowReason');

// ---------------------------------------------------------------------------------------------
// Opening the pending panel on a running publish

/** Where "show me the publish" goes: the cart drawer of the open app when it covers that app, else the app's pending page. */
export type PanelTarget = { kind: 'drawer' } | { kind: 'page'; href: string };

export function panelTarget(input: {
  appId: string;
  /** The records the open app's cart drawer covers (none when no drawer is mounted). */
  drawerAppIds: readonly string[];
  /** A drawer is mounted and can be opened. */
  drawerReady: boolean;
  scope?: PlatformScope | null | undefined;
}): PanelTarget {
  if (input.drawerReady && input.drawerAppIds.includes(input.appId)) return { kind: 'drawer' };
  return { kind: 'page', href: appAddress(input.appId, 'pending', input.scope ?? null) };
}

/** Which of the running apps the top bar button shows: the one the open app's drawer covers, else the first (stable order). */
export function appToShow(
  running: readonly string[],
  drawerAppIds: readonly string[],
): string | null {
  return running.find((id) => drawerAppIds.includes(id)) ?? running[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Polling

export const POLL_MS = PUBLISH_POLL_VISIBLE_MS;
export const HIDDEN_POLL_MS = PUBLISH_POLL_HIDDEN_MS;
export const MAX_POLL_MS = PUBLISH_POLL_MAX_MS;

/**
 * When to read again: `null` when no publish runs (nothing is polled; a focus or a stage reads once); every 5 seconds while one does;
 * every 30 seconds in a hidden tab; doubling after each failed read, up to a minute.
 */
export function pollDelay(input: {
  publishing: boolean;
  hidden: boolean;
  failures: number;
}): number | null {
  if (!input.publishing) return null;
  const base = input.hidden ? HIDDEN_POLL_MS : POLL_MS;
  if (input.failures <= 0) return base;
  return Math.min(MAX_POLL_MS, base * 2 ** Math.min(input.failures, 6));
}

/** The apps that were publishing and no longer are: their claim is gone, so the screens read what the publish left. */
export const finishedApps = (before: readonly string[], after: readonly string[]): string[] =>
  before.filter((id) => !after.includes(id));

// ---------------------------------------------------------------------------------------------
// The loader

type Timer = (fn: () => void, ms: number) => () => void;
const realTimer: Timer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/**
 * How long a publish this browser started may go unseen by the server before it is dropped (the request failed before it took its
 * claim): a read that finds no claim after this long ends the mark at once, whatever the dialog still waits for.
 */
export const OPTIMISTIC_GRACE_MS = 30_000;

/** A mark this browser made is never kept longer than the dialog waits for the answer (and reads that fail do not keep it either). */
export const OPTIMISTIC_LIMIT_MS = PUBLISH_WAIT_LIMIT_MS;

/**
 * Keeps ONE view of which apps of the workspace are publishing, for every screen. `start` (a screen that needs it is shown) reads now and
 * then keeps reading while a publish runs, and stops when none does; `refresh` reads once (focus, a dialog that closed). A publish this
 * browser started (`mark`) is shown before the server answers and is confirmed by the first read that sees it. An app that was
 * publishing and is not any more (confirmed by the server, or settled) is reported once through `onFinished`. A change of workspace
 * drops everything; an answer that is not the latest read is ignored; a failed read keeps what was shown and backs off.
 */
export function createPublishingLoader(opts: {
  read: (workspaceId: string) => Promise<PublishingList>;
  onChange: () => void;
  onFinished: (workspaceId: string, appIds: string[]) => void;
  hidden?: () => boolean;
  now?: () => number;
  timer?: Timer;
}) {
  const now = opts.now ?? Date.now;
  const timer = opts.timer ?? realTimer;
  const hidden = opts.hidden ?? (() => false);
  let workspace = '';
  let known: Record<string, PublishingEntry> = {};
  /** Apps the server has shown as publishing (so a missing one means it finished). */
  let confirmed = new Set<string>();
  /** The latest publish of each app that did not complete (from the server, or noted from this browser's own answer). */
  let failed: Record<string, LastPublish> = {};
  let token = 0;
  let failures = 0;
  let watchers = 0;
  let stop: (() => void) | null = null;

  const idsOf = () => Object.keys(known);
  const scope = (workspaceId: string) => {
    if (workspaceId === workspace) return;
    workspace = workspaceId;
    known = {};
    confirmed = new Set();
    failed = {};
    failures = 0;
    token += 1;
    stop?.();
    stop = null;
    opts.onChange();
  };
  function schedule() {
    stop?.();
    stop = null;
    if (watchers === 0) return;
    const wait = pollDelay({ publishing: idsOf().length > 0, hidden: hidden(), failures });
    if (wait === null) return;
    const space = workspace;
    stop = timer(() => {
      stop = null;
      void refresh(space);
    }, wait);
  }
  async function refresh(workspaceId: string): Promise<void> {
    scope(workspaceId);
    const mine = ++token;
    try {
      const list = await opts.read(workspaceId);
      if (mine !== token || workspaceId !== workspace) return;
      failures = 0;
      const at = now();
      const next: Record<string, PublishingEntry> = {};
      for (const { appId, publishing } of list.apps) next[appId] = publishing;
      const finished: string[] = [];
      for (const id of idsOf()) {
        if (next[id] !== undefined) continue;
        const mineEntry = known[id];
        if (mineEntry?.optimistic && !confirmed.has(id)) {
          // Not seen by the server yet: keep it for a while (the request may not have taken its claim yet).
          if (at - mineEntry.startedAt < OPTIMISTIC_GRACE_MS) next[id] = mineEntry;
          continue;
        }
        finished.push(id);
      }
      for (const id of Object.keys(next)) if (!next[id]?.optimistic) confirmed.add(id);
      for (const id of finished) confirmed.delete(id);
      known = next;
      if (list.lastPublish !== undefined) {
        const nextFailed: Record<string, LastPublish> = {};
        for (const entry of list.lastPublish) nextFailed[entry.appId] = entry.lastPublish;
        failed = nextFailed;
      }
      opts.onChange();
      if (finished.length > 0) opts.onFinished(workspaceId, finished);
    } catch {
      if (mine !== token || workspaceId !== workspace) return;
      failures += 1;
      // The server cannot be read: a mark this browser made still expires with the dialog's own limit, so it is never shown for ever.
      const at = now();
      const gone = idsOf().filter((id) => {
        const entry = known[id];
        return entry?.optimistic === true && at - entry.startedAt >= OPTIMISTIC_LIMIT_MS;
      });
      if (gone.length > 0) {
        const kept: Record<string, PublishingEntry> = {};
        for (const id of idsOf()) {
          const entry = known[id];
          if (entry !== undefined && !gone.includes(id)) kept[id] = entry;
        }
        known = kept;
        opts.onChange();
        opts.onFinished(workspaceId, gone);
      }
    }
    schedule();
  }
  return {
    of: (workspaceId: string, appId: string): PublishingEntry | null =>
      workspaceId === workspace ? (known[appId] ?? null) : null,
    ids: (workspaceId: string): string[] => (workspaceId === workspace ? idsOf() : []),
    /** The latest publish of the app that did not complete and is not dismissed, or null. */
    failedOf: (workspaceId: string, appId: string): LastPublish | null =>
      workspaceId === workspace ? (failed[appId] ?? null) : null,
    /** The apps of the workspace whose latest publish did not complete. */
    failedIds: (workspaceId: string): string[] =>
      workspaceId === workspace ? Object.keys(failed) : [],
    /** This browser got the answer of a publish that did not go through (or one that did: `null` clears the app). */
    noteResult(workspaceId: string, appId: string, run: LastPublish | null): void {
      scope(workspaceId);
      const { [appId]: _old, ...rest } = failed;
      failed = run !== null && !run.completed && !run.dismissed ? { ...rest, [appId]: run } : rest;
      opts.onChange();
    },
    refresh,
    /** A screen needs the answer: read now, keep reading while a publish runs. Returns the function that lets go. */
    start(workspaceId: string): () => void {
      scope(workspaceId);
      watchers += 1;
      void refresh(workspaceId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers -= 1;
        if (watchers === 0) {
          stop?.();
          stop = null;
        }
      };
    },
    /** This browser sent a publish: show it at once. The server's own claim replaces it. */
    mark(workspaceId: string, appId: string, steps: readonly PublishStepType[]): void {
      scope(workspaceId);
      if (known[appId] !== undefined) return;
      known = {
        ...known,
        [appId]: {
          startedAt: now(),
          steps: [...steps],
          currentStep: null,
          stepStartedAt: null,
          by: null,
          optimistic: true,
        },
      };
      opts.onChange();
      schedule();
    },
    /**
     * The answer of this browser's publish arrived (or failed before the server took a claim): what was marked is over. Reported as finished
     * when it was shown, so the screens read what the publish left.
     */
    settle(workspaceId: string, appId: string): void {
      if (workspaceId !== workspace || known[appId] === undefined) return;
      const { [appId]: _gone, ...rest } = known;
      known = rest;
      confirmed.delete(appId);
      opts.onChange();
      opts.onFinished(workspaceId, [appId]);
    },
    reset(): void {
      workspace = '';
      known = {};
      failed = {};
      confirmed = new Set();
      failures = 0;
      token += 1;
      stop?.();
      stop = null;
    },
  };
}
