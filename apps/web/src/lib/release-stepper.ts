import {
  byFamily,
  can,
  type Platform,
  type Role,
  type StagedChangesView,
  type StagedReleaseFieldView,
  stagedCountsOf,
  supports,
} from '@kiln/core';
import { appAddress, type PlatformScope, parseViewPath } from './app-scope.ts';
import { readVersionOf } from './build-origin.ts';
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { BuildCandidate, CodeCandidate, EditableRelease } from './release-candidates.ts';

/**
 * The "Prepare release" stepper of an app (Releases tab): Build, Notes, Assets, Review, Confirm. Pure logic: which steps a
 * person sees, the readiness dot of each, what is chosen, and the address of a step. Nothing here reads or writes anything:
 * the steps only stage changes in our own database, and only the Confirm step reaches a store, through the gated dialogs
 * that already exist (push draft, submit, release, rollout). Written for the ES2017 web build.
 */

export type StepId = 'build' | 'notes' | 'assets' | 'review' | 'confirm';
export const STEP_IDS: readonly StepId[] = ['build', 'notes', 'assets', 'review', 'confirm'];
/**
 * The name of each step, in the active language. The values are read when used (getters), so a module that holds on to this object
 * (the stepper layout) still shows the language of the moment.
 */
export const STEP_LABELS: Readonly<Record<StepId, string>> = {
  get build() {
    return t('release-stepper:step.build');
  },
  get notes() {
    return t('release-stepper:step.notes');
  },
  get assets() {
    return t('release-stepper:step.assets');
  },
  get review() {
    return t('release-stepper:step.review');
  },
  get confirm() {
    return t('release-stepper:step.confirm');
  },
};

export const isStepId = (value: string | null | undefined): value is StepId =>
  value !== null && value !== undefined && (STEP_IDS as readonly string[]).indexOf(value) >= 0;

// ---------------------------------------------------------------------------------------------
// The address: `#/portfolio/<id>/releases?platform=ios&version=2.4.0&step=notes`

/** The step the address asks for, or null (the stepper is closed). */
export function stepFromHash(hash: string): StepId | null {
  const value = parseViewPath(hash).query.get('step');
  return isStepId(value) ? value : null;
}

/** The same address with another step (null closes the stepper); the rest of the query stays. */
export function withStep(hash: string, step: StepId | null): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (step === null) params.delete('step');
  else params.set('step', step);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** What "Create release 2.0.1 from TestFlight build 95" fills in: the version string and the build number from the address (`&version=2.0.1&build=95`). */
export type StepPrefill = { version: string | null; build: string | null };

const PREFILL = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

/** The version and the build the address asks the first step to start from; null when it asks for neither. Nothing is trusted: a value that is not a plain version or build string is dropped. */
export function prefillFromHash(hash: string): StepPrefill | null {
  const query = parseViewPath(hash).query;
  const version = query.get('version');
  const build = query.get('build');
  const out: StepPrefill = {
    version: version !== null && PREFILL.test(version) ? version : null,
    build: build !== null && PREFILL.test(build) ? build : null,
  };
  return out.version === null && out.build === null ? null : out;
}

/** The link to a step of an app: the releases tab, the platform scope, the version and the step. */
export function releaseStepHref(
  appId: string,
  scope: PlatformScope | null,
  step: StepId,
  version: string | null = null,
): string {
  const base = appAddress(appId, 'releases', scope);
  const at = base.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : base.slice(at + 1));
  if (version !== null && version !== '') params.set('version', version);
  params.set('step', step);
  return `${at < 0 ? base : base.slice(0, at)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Which steps a person sees

export type Switches = {
  /** `KILN_STORE_DRAFT_WRITE_ENABLED`; null: not known (yet). */
  draft: boolean | null;
  submit: boolean | null;
  release: boolean | null;
};

const mayWriteToStore = (role: Role): boolean =>
  can(role, 'store.push_draft') || can(role, 'store.submit') || can(role, 'store.release');

/** The Confirm step needs a right to write and at least one switch that is not known to be off. */
export function confirmAllowed(role: Role, switches: Switches): boolean {
  if (!mayWriteToStore(role)) return false;
  return !(switches.draft === false && switches.submit === false && switches.release === false);
}

export function visibleSteps(role: Role, switches: Switches): StepId[] {
  const out: StepId[] = [];
  for (const id of STEP_IDS) {
    if (id === 'confirm') {
      if (confirmAllowed(role, switches)) out.push(id);
    } else if (can(role, 'listing.read')) out.push(id);
  }
  return out;
}

/** One quiet sentence under the stepper when the last step is not shown, so nobody wonders where it went. Null when it is shown. */
export function confirmHiddenReason(role: Role, switches: Switches): string | null {
  if (confirmAllowed(role, switches)) return null;
  if (!mayWriteToStore(role)) return t('release-stepper:hidden.role');
  return t('release-stepper:hidden.switchedOff');
}

/** The step after or before `id` among the visible ones; null at the ends. */
export function neighbour(
  id: StepId,
  visible: readonly StepId[],
  direction: 1 | -1,
): StepId | null {
  const i = visible.indexOf(id);
  const next = visible[i + direction];
  return i < 0 || next === undefined ? null : next;
}

/** The step to show: the one asked for when visible, else the first. */
export const resolveStep = (asked: StepId | null, visible: readonly StepId[]): StepId | null =>
  asked !== null && visible.indexOf(asked) >= 0 ? asked : (visible[0] ?? null);

// ---------------------------------------------------------------------------------------------
// What is staged

export type StagedFacts = {
  /** Staged release fields, texts and graphic sets. */
  release: number;
  texts: number;
  /** Graphic sets staged (pushed ones included: what the staging area holds). */
  assets: number;
  /** Graphic sets staged and not pushed yet (core's `stagedCountsOf`). */
  unpushedAssets: number;
  total: number;
  errors: number;
  warnings: number;
  /** Items that are not in the store draft yet (a push would write them). */
  unpushed: number;
};

type WithProblems = { problems: readonly { severity: string }[] };

export function stagedFacts(view: StagedChangesView | null): StagedFacts {
  if (view === null)
    return {
      release: 0,
      texts: 0,
      assets: 0,
      unpushedAssets: 0,
      total: 0,
      errors: 0,
      warnings: 0,
      unpushed: 0,
    };
  const release = view.release ?? [];
  const all: WithProblems[] = [...view.text, ...view.assets, ...release];
  const count = (severity: string) =>
    all.reduce((n, i) => n + i.problems.filter((p) => p.severity === severity).length, 0);
  const counts = stagedCountsOf(view);
  return {
    release: release.length,
    texts: view.text.length,
    assets: counts.totalSets,
    unpushedAssets: counts.unpushedSets,
    total: release.length + view.text.length + view.assets.length,
    errors: count('error'),
    warnings: count('warning'),
    unpushed:
      view.text.filter((t) => !t.pushed && t.status !== 'unchanged').length +
      counts.unpushedSets +
      release.filter((r) => !r.pushed && !r.localOnly).length,
  };
}

export const stagedField = (
  view: StagedChangesView | null,
  field: string,
  locale = '',
): StagedReleaseFieldView | null =>
  (view?.release ?? []).filter((r) => r.field === field && r.locale === locale)[0] ?? null;

/** The staged "what is new" per language: the listing text `release_notes` (App Store) or the Play release field. */
export function stagedNotes(
  view: StagedChangesView | null,
  platform: Platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (view === null) return out;
  if (!supports(platform, 'releaseTracks')) {
    for (const t of view.text) if (t.field === 'release_notes') out[t.locale] = t.value;
  } else {
    for (const r of view.release ?? []) if (r.field === 'release_notes') out[r.locale] = r.value;
  }
  return out;
}

/** The "what is new" the store holds now, per language, from the read of the editable release. */
export function storeNotes(editable: EditableRelease | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (editable === null) return out;
  const list =
    editable.store === 'appstoreconnect' ? editable.releaseNotes : (editable.draft?.notes ?? []);
  for (const n of list) out[n.locale] = n.text;
  return out;
}

// ---------------------------------------------------------------------------------------------
// What is chosen

export type Chosen = { label: string; where: 'staged' | 'store' };

/**
 * "Version codes 90, 89 on production", and "Version code 90 · 2.00.1 on production" when every chosen code is known to be the same
 * version (read from a CI file or the store: a release name is not enough). A code the read does not list counts as not known.
 */
function codesLabel(
  codes: readonly string[],
  track: string | null,
  known: readonly CodeCandidate[],
): string {
  const versions = codes.map((c) => {
    const hit = known.filter((k) => k.versionCode === c)[0];
    return hit ? readVersionOf(hit) : null;
  });
  const first = versions[0];
  const same = first !== null && first !== undefined && versions.every((v) => v === first);
  const list = codes.join(', ');
  if (same && track)
    return t('release-stepper:chosen.codesVersionOn', {
      count: codes.length,
      codes: list,
      version: first,
      track,
    });
  if (same)
    return t('release-stepper:chosen.codesVersion', {
      count: codes.length,
      codes: list,
      version: first,
    });
  return track
    ? t('release-stepper:chosen.codesOn', { codes: list, track })
    : t('release-stepper:chosen.codes', { codes: list });
}

/** The build (App Store) or the version codes and track (Google Play) of this release: staged first, else what the store draft has. */
export function chosenOf(input: {
  platform: Platform;
  view: StagedChangesView | null;
  editable: EditableRelease | null;
  builds: readonly BuildCandidate[];
  /** The version codes of the read (Google Play): when they say which version the chosen codes are, the label says it too. */
  codes?: readonly CodeCandidate[] | undefined;
}): Chosen | null {
  if (!supports(input.platform, 'releaseTracks')) {
    const staged = stagedField(input.view, 'build');
    if (staged !== null) {
      const hit = input.builds.filter((b) => b.id === staged.value)[0];
      return {
        label:
          hit && hit.buildNumber !== null
            ? t('release-stepper:chosen.build', { number: hit.buildNumber })
            : t('release-stepper:chosen.aBuild'),
        where: 'staged',
      };
    }
    if (
      input.editable !== null &&
      input.editable.store === 'appstoreconnect' &&
      input.editable.build !== null
    ) {
      const n = input.editable.build.buildNumber;
      return {
        label:
          n !== null
            ? t('release-stepper:chosen.build', { number: n })
            : t('release-stepper:chosen.aBuild'),
        where: 'store',
      };
    }
    return null;
  }
  const codes = stagedField(input.view, 'version_codes');
  const track = stagedField(input.view, 'track');
  if (codes !== null)
    return {
      label: codesLabel(
        codes.value.split(',').filter((c) => c !== ''),
        track ? track.value : null,
        input.codes ?? [],
      ),
      where: 'staged',
    };
  if (
    input.editable !== null &&
    input.editable.store === 'googleplay' &&
    input.editable.draft !== null &&
    input.editable.draft.versionCodes.length > 0
  ) {
    return {
      label: codesLabel(
        input.editable.draft.versionCodes.map(String),
        input.editable.track,
        input.codes ?? [],
      ),
      where: 'store',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The readiness dot of each step

export type Level = 'ready' | 'todo' | 'attention' | 'blocked' | 'optional' | 'unknown';
export type StepStatus = { id: StepId; label: string; level: Level; text: string };

export type EditableState = { state: 'loading' | 'ready' | 'none' | 'error'; message?: string };

export type StepperFacts = {
  platform: Platform;
  editable: EditableState;
  chosen: Chosen | null;
  /** Builds (App Store) or codes (Google Play) that can be chosen; null: not read yet. */
  choices: number | null;
  /** From `releaseNotesView`: languages with text, typed and not staged, over the limit, listing languages with no text*/
  notes: { withText: number; unsaved: number; over: number; missing?: number };
  staged: StagedFacts;
  pipeline: { state: string; waitingOn: 'ci' | 'store' | 'you' | null } | null;
};

export function buildStatus(f: StepperFacts): StepStatus {
  const base = { id: 'build' as const, label: STEP_LABELS.build };
  if (f.chosen !== null)
    return {
      ...base,
      level: 'ready',
      text:
        f.chosen.where === 'staged'
          ? t('release-stepper:build.chosenStaged', { label: f.chosen.label })
          : t('release-stepper:build.chosenStore', { label: f.chosen.label }),
    };
  if (f.editable.state === 'loading')
    return { ...base, level: 'unknown', text: t('release-stepper:build.reading') };
  if (f.editable.state === 'error')
    return { ...base, level: 'unknown', text: t('release-stepper:build.readError') };
  if (f.editable.state === 'none') {
    return {
      ...base,
      level: 'blocked',
      text: !supports(f.platform, 'releaseTracks')
        ? t('release-stepper:build.noVersionApple')
        : t('release-stepper:build.noDraftGoogle'),
    };
  }
  if (f.choices === 0)
    return {
      ...base,
      level: 'attention',
      text: !supports(f.platform, 'releaseTracks')
        ? t('release-stepper:build.noBuildApple')
        : t('release-stepper:build.noCodeGoogle'),
    };
  return {
    ...base,
    level: 'todo',
    text: byFamily(f.platform, {
      apple: t('release-stepper:build.chooseApple'),
      google: t('release-stepper:build.chooseGoogle'),
    }),
  };
}

export function notesStatus(f: StepperFacts): StepStatus {
  const base = { id: 'notes' as const, label: STEP_LABELS.notes };
  if (f.notes.unsaved > 0)
    return {
      ...base,
      level: 'attention',
      text: t('release-stepper:notes.unsaved', { count: f.notes.unsaved }),
    };
  if (f.notes.over > 0)
    return {
      ...base,
      level: 'attention',
      text: t('release-stepper:notes.over', { count: f.notes.over }),
    };
  if (f.notes.withText === 0)
    return { ...base, level: 'todo', text: t('release-stepper:notes.none') };
  if ((f.notes.missing ?? 0) > 0)
    return {
      ...base,
      level: 'attention',
      text: t('release-stepper:notes.partial', { count: f.notes.missing }),
    };
  return {
    ...base,
    level: 'ready',
    text: t('release-stepper:notes.ready', { count: f.notes.withText }),
  };
}

export function assetsStatus(f: StepperFacts): StepStatus {
  const base = { id: 'assets' as const, label: STEP_LABELS.assets };
  if (f.staged.assets === 0)
    return { ...base, level: 'optional', text: t('release-stepper:assets.none') };
  return {
    ...base,
    level: 'ready',
    text: t('release-stepper:assets.staged', { count: f.staged.assets }),
  };
}

export function reviewStatus(f: StepperFacts): StepStatus {
  const base = { id: 'review' as const, label: STEP_LABELS.review };
  if (f.staged.errors > 0)
    return {
      ...base,
      level: 'blocked',
      text: t('release-stepper:review.errors', { count: f.staged.errors }),
    };
  if (f.staged.total === 0)
    return { ...base, level: 'optional', text: t('release-stepper:review.nothing') };
  return {
    ...base,
    level: 'ready',
    text:
      f.staged.warnings > 0
        ? formatList(
            [
              t('release-stepper:review.changes', { count: f.staged.total }),
              t('release-stepper:review.warnings', { count: f.staged.warnings }),
            ],
            { type: 'unit' },
          )
        : t('release-stepper:review.changes', { count: f.staged.total }),
  };
}

export function confirmStatus(f: StepperFacts): StepStatus {
  const base = { id: 'confirm' as const, label: STEP_LABELS.confirm };
  if (f.staged.errors > 0)
    return { ...base, level: 'blocked', text: t('release-stepper:confirm.fixErrors') };
  if (f.staged.unpushed > 0) {
    // Google Play, a build chosen for a track and nothing else staged: the publish RELEASES it (one step, sent to Google for review),
    // it does not park it as a draft. Said so, instead of "push to the store draft".
    const buildOnly =
      supports(f.platform, 'releaseTracks') && f.staged.texts === 0 && f.staged.assets === 0;
    return {
      ...base,
      level: 'todo',
      text: buildOnly
        ? t('release-stepper:confirm.releaseBuild', { count: f.staged.unpushed })
        : t('release-stepper:confirm.push', { count: f.staged.unpushed }),
    };
  }
  const p = f.pipeline;
  if (p === null) return { ...base, level: 'unknown', text: t('release-stepper:confirm.unknown') };
  switch (p.state) {
    case 'draft':
      return !supports(f.platform, 'releaseTracks')
        ? { ...base, level: 'todo', text: t('release-stepper:confirm.draftApple') }
        : { ...base, level: 'todo', text: t('release-stepper:confirm.draftGoogle') };
    case 'in_review':
      return { ...base, level: 'optional', text: t('release-stepper:confirm.inReview') };
    case 'rejected':
      return {
        ...base,
        level: 'attention',
        text: t('release-stepper:confirm.rejected'),
      };
    case 'approved':
      return {
        ...base,
        level: 'todo',
        text: !supports(f.platform, 'releaseTracks')
          ? t('release-stepper:confirm.approvedApple')
          : t('release-stepper:confirm.approvedGoogle'),
      };
    case 'rolling_out':
      return { ...base, level: 'ready', text: t('release-stepper:confirm.rolling') };
    case 'halted':
      return { ...base, level: 'attention', text: t('release-stepper:confirm.halted') };
    case 'live':
      return { ...base, level: 'ready', text: t('release-stepper:confirm.live') };
    default:
      return { ...base, level: 'optional', text: t('release-stepper:confirm.nothing') };
  }
}

export function stepStatuses(f: StepperFacts, visible: readonly StepId[]): StepStatus[] {
  const all: Record<StepId, StepStatus> = {
    build: buildStatus(f),
    notes: notesStatus(f),
    assets: assetsStatus(f),
    review: reviewStatus(f),
    confirm: confirmStatus(f),
  };
  return visible.map((id) => all[id]);
}

/** The dot of a level: its tone for the design tokens, and the word that goes with it (never colour alone). */
export const LEVEL_TONE: Readonly<Record<Level, 'ok' | 'info' | 'warn' | 'bad' | 'neutral'>> = {
  ready: 'ok',
  todo: 'info',
  attention: 'warn',
  blocked: 'bad',
  optional: 'neutral',
  unknown: 'neutral',
};
/** Message keys (not text): `t(LEVEL_WORD[level])` where the dot is drawn. */
export const LEVEL_WORD: Readonly<Record<Level, string>> = {
  ready: k('release-stepper:level.ready'),
  todo: k('release-stepper:level.todo'),
  attention: k('release-stepper:level.attention'),
  blocked: k('release-stepper:level.blocked'),
  optional: k('release-stepper:level.optional'),
  unknown: k('release-stepper:level.unknown'),
};

/** The version the stepper works on: the one asked for, else the editable one (Prepare for Submission or a draft), else the newest. */
export function pickVersion(
  requested: string | null,
  options: readonly { version: string; editable: boolean }[],
): string | null {
  if (requested !== null && options.some((o) => o.version === requested)) return requested;
  return options.filter((o) => o.editable)[0]?.version ?? options[0]?.version ?? null;
}
