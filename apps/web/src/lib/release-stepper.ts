import {
  byFamily,
  can,
  type Platform,
  type Role,
  type StagedChangesView,
  type StagedReleaseFieldView,
  supports,
} from '@mrm/core';
import { appAddress, type PlatformScope, parseViewPath } from './app-scope.ts';
import type { BuildCandidate, EditableRelease } from './release-candidates.ts';

/**
 * The "Prepare release" stepper of an app (Releases tab): Build, Notes, Assets, Review, Confirm. Pure logic: which steps a
 * person sees, the readiness dot of each, what is chosen, and the address of a step. Nothing here reads or writes anything:
 * the steps only stage changes in our own database, and only the Confirm step reaches a store, through the gated dialogs
 * that already exist (push draft, submit, release, rollout). Written for the ES2017 web build.
 */

export type StepId = 'build' | 'notes' | 'assets' | 'review' | 'confirm';
export const STEP_IDS: readonly StepId[] = ['build', 'notes', 'assets', 'review', 'confirm'];
export const STEP_LABELS: Readonly<Record<StepId, string>> = {
  build: 'Build',
  notes: 'Notes',
  assets: 'Assets',
  review: 'Review',
  confirm: 'Confirm',
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
  /** `MRM_STORE_DRAFT_WRITE_ENABLED`; null: not known (yet). */
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
  if (!mayWriteToStore(role))
    return 'Pushing, submitting and releasing need the admin or owner role, so the last step is not shown. You can still prepare the release.';
  return 'Writing to a store is switched off on this server, so the last step is not shown. The other steps stage changes in this tool only.';
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
  assets: number;
  total: number;
  errors: number;
  warnings: number;
  /** Items that are not in the store draft yet (a push would write them). */
  unpushed: number;
};

type WithProblems = { problems: readonly { severity: string }[] };

export function stagedFacts(view: StagedChangesView | null): StagedFacts {
  if (view === null)
    return { release: 0, texts: 0, assets: 0, total: 0, errors: 0, warnings: 0, unpushed: 0 };
  const release = view.release ?? [];
  const all: WithProblems[] = [...view.text, ...view.assets, ...release];
  const count = (severity: string) =>
    all.reduce((n, i) => n + i.problems.filter((p) => p.severity === severity).length, 0);
  return {
    release: release.length,
    texts: view.text.length,
    assets: view.assets.length,
    total: release.length + view.text.length + view.assets.length,
    errors: count('error'),
    warnings: count('warning'),
    unpushed:
      view.text.filter((t) => !t.pushed && t.status !== 'unchanged').length +
      view.assets.filter((a) => !a.pushed).length +
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

/** The build (App Store) or the version codes and track (Google Play) of this release: staged first, else what the store draft has. */
export function chosenOf(input: {
  platform: Platform;
  view: StagedChangesView | null;
  editable: EditableRelease | null;
  builds: readonly BuildCandidate[];
}): Chosen | null {
  if (!supports(input.platform, 'releaseTracks')) {
    const staged = stagedField(input.view, 'build');
    if (staged !== null) {
      const hit = input.builds.filter((b) => b.id === staged.value)[0];
      return {
        label: hit && hit.buildNumber !== null ? `Build ${hit.buildNumber}` : 'A build',
        where: 'staged',
      };
    }
    if (
      input.editable !== null &&
      input.editable.store === 'appstoreconnect' &&
      input.editable.build !== null
    ) {
      const n = input.editable.build.buildNumber;
      return { label: n !== null ? `Build ${n}` : 'A build', where: 'store' };
    }
    return null;
  }
  const codes = stagedField(input.view, 'version_codes');
  const track = stagedField(input.view, 'track');
  if (codes !== null)
    return {
      label: `Version codes ${codes.value.split(',').join(', ')}${track ? ` on ${track.value}` : ''}`,
      where: 'staged',
    };
  if (
    input.editable !== null &&
    input.editable.store === 'googleplay' &&
    input.editable.draft !== null &&
    input.editable.draft.versionCodes.length > 0
  ) {
    return {
      label: `Version codes ${input.editable.draft.versionCodes.join(', ')} on ${input.editable.track}`,
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
  notes: { withText: number; unsaved: number; over: number };
  staged: StagedFacts;
  pipeline: { state: string; waitingOn: 'ci' | 'store' | 'you' | null } | null;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function buildStatus(f: StepperFacts): StepStatus {
  const base = { id: 'build' as const, label: STEP_LABELS.build };
  if (f.chosen !== null)
    return {
      ...base,
      level: 'ready',
      text: `${f.chosen.label}${f.chosen.where === 'staged' ? ', staged' : ', in the store draft'}`,
    };
  if (f.editable.state === 'loading')
    return { ...base, level: 'unknown', text: 'Reading the store' };
  if (f.editable.state === 'error')
    return { ...base, level: 'unknown', text: 'Could not read the store. See below' };
  if (f.editable.state === 'none') {
    return {
      ...base,
      level: 'blocked',
      text: !supports(f.platform, 'releaseTracks')
        ? 'No version is in Prepare for Submission'
        : 'No draft release on that track yet',
    };
  }
  if (f.choices === 0)
    return {
      ...base,
      level: 'attention',
      text: !supports(f.platform, 'releaseTracks')
        ? 'No build can be chosen yet'
        : 'No version code can be added yet',
    };
  return {
    ...base,
    level: 'todo',
    text: byFamily(f.platform, { apple: 'Choose a build', google: 'Choose the version codes' }),
  };
}

export function notesStatus(f: StepperFacts): StepStatus {
  const base = { id: 'notes' as const, label: STEP_LABELS.notes };
  if (f.notes.unsaved > 0)
    return {
      ...base,
      level: 'attention',
      text: `${plural(f.notes.unsaved, 'language is', 'languages are')} not staged yet`,
    };
  if (f.notes.over > 0)
    return {
      ...base,
      level: 'attention',
      text: `${plural(f.notes.over, 'text is', 'texts are')} over the store limit`,
    };
  if (f.notes.withText === 0) return { ...base, level: 'todo', text: 'No release notes yet' };
  return {
    ...base,
    level: 'ready',
    text: plural(f.notes.withText, 'language has notes', 'languages have notes'),
  };
}

export function assetsStatus(f: StepperFacts): StepStatus {
  const base = { id: 'assets' as const, label: STEP_LABELS.assets };
  if (f.staged.assets === 0) return { ...base, level: 'optional', text: 'Nothing staged' };
  return {
    ...base,
    level: 'ready',
    text: `${plural(f.staged.assets, 'graphic set', 'graphic sets')} staged`,
  };
}

export function reviewStatus(f: StepperFacts): StepStatus {
  const base = { id: 'review' as const, label: STEP_LABELS.review };
  if (f.staged.errors > 0)
    return {
      ...base,
      level: 'blocked',
      text: `${plural(f.staged.errors, 'error', 'errors')} in the staged changes`,
    };
  if (f.staged.total === 0) return { ...base, level: 'optional', text: 'Nothing is staged' };
  return {
    ...base,
    level: 'ready',
    text: `${plural(f.staged.total, 'staged change', 'staged changes')}${f.staged.warnings > 0 ? `, ${plural(f.staged.warnings, 'warning', 'warnings')}` : ''}`,
  };
}

export function confirmStatus(f: StepperFacts): StepStatus {
  const base = { id: 'confirm' as const, label: STEP_LABELS.confirm };
  if (f.staged.errors > 0)
    return { ...base, level: 'blocked', text: 'Fix the errors in the staged changes first' };
  if (f.staged.unpushed > 0)
    return {
      ...base,
      level: 'todo',
      text: `Push ${plural(f.staged.unpushed, 'staged change', 'staged changes')} to the store draft`,
    };
  const p = f.pipeline;
  if (p === null)
    return { ...base, level: 'unknown', text: 'The state of the release is not known' };
  switch (p.state) {
    case 'draft':
      return !supports(f.platform, 'releaseTracks')
        ? { ...base, level: 'todo', text: 'The draft is pushed: submit it for review' }
        : { ...base, level: 'todo', text: 'The draft is pushed: release it at a share of users' };
    case 'in_review':
      return { ...base, level: 'optional', text: 'In review: waiting on the store' };
    case 'rejected':
      return {
        ...base,
        level: 'attention',
        text: 'Rejected: fix what the store asks for, then push and submit again',
      };
    case 'approved':
      return {
        ...base,
        level: 'todo',
        text: !supports(f.platform, 'releaseTracks')
          ? 'Approved: waiting for you to release it'
          : 'Approved: release it at a share of users',
      };
    case 'rolling_out':
      return { ...base, level: 'ready', text: 'Rolling out' };
    case 'halted':
      return { ...base, level: 'attention', text: 'The rollout is halted' };
    case 'live':
      return { ...base, level: 'ready', text: 'Live' };
    default:
      return { ...base, level: 'optional', text: 'Nothing to confirm yet' };
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
export const LEVEL_WORD: Readonly<Record<Level, string>> = {
  ready: 'Ready',
  todo: 'To do',
  attention: 'Look at this',
  blocked: 'Blocked',
  optional: 'Optional',
  unknown: 'Not known',
};

/** The version the stepper works on: the one asked for, else the editable one (Prepare for Submission or a draft), else the newest. */
export function pickVersion(
  requested: string | null,
  options: readonly { version: string; editable: boolean }[],
): string | null {
  if (requested !== null && options.some((o) => o.version === requested)) return requested;
  return options.filter((o) => o.editable)[0]?.version ?? options[0]?.version ?? null;
}
