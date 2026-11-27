import type { Platform, ReadinessFixKind, SubmitBlocker, SubmitReadiness } from '@kiln/core';
import { supports } from '@kiln/core';
import { k, t } from './i18n/t.ts';
import { reviewFromParam } from './review-information.ts';
import { APP_STORE_CONNECT_APPS_URL, PLAY_CONSOLE_URL } from './store-links.ts';

/**
 * Whether the draft could be submitted once the staged push is made, as a person reads it (docs/api/pending.md "Readiness"). Pure: from the
 * `readiness` of the plan the server made (`predictDraft` judged by the same rules as the submit itself) it builds the one answer every
 * screen shows: "Ready to submit for review" or "Submit would not run yet: N things to fix", the list (the server's sentence, how to fix it,
 * where), the codes that are only checked after the push, and the choice a person gets when a push and a submit were asked together.
 * Nothing here decides a rule: the server does. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** What a plan carries (`PublishPlan.readiness`). */
export type PlanReadiness = {
  submit: SubmitReadiness & { predicted: boolean; checkedAt: number };
};

/** What `GET /apps/:id/publish/readiness` answers (docs/api/pending.md "Current readiness"): what blocks a submit NOW, read from the store. */
export type PublishReadiness = {
  appId: string;
  ready: boolean;
  blockers: SubmitBlocker[];
  unknown: string[];
  /** The staged push was merged into the store's draft. */
  predicted: boolean;
  versionString: string | null;
  /** When the store was read (epoch ms). */
  storeReadAt: number;
  /** The server answered from its 30 second cache. */
  cached: boolean;
};

/** How to fix each blocker, before anything is pushed. An unknown code gets the generic sentence. */
type FixCode =
  | 'missing_text'
  | 'no_locales'
  | 'no_screenshots'
  | 'asset_spec'
  | 'release_notes_too_long'
  | 'no_build'
  | 'build_expired'
  | 'build_not_valid'
  | 'already_submitted'
  | 'no_version'
  | 'release_not_manual'
  | 'no_review_contact'
  | 'no_review_demo_account'
  | 'generic';

const FIX: Readonly<Record<FixCode, string>> = {
  missing_text: k('publish:readiness.fix.missingText'),
  no_locales: k('publish:readiness.fix.noLocales'),
  no_screenshots: k('publish:readiness.fix.noScreenshots'),
  asset_spec: k('publish:readiness.fix.assetSpec'),
  release_notes_too_long: k('publish:readiness.fix.notesTooLong'),
  no_build: k('publish:readiness.fix.noBuild'),
  build_expired: k('publish:readiness.fix.buildExpired'),
  build_not_valid: k('publish:readiness.fix.buildNotValid'),
  already_submitted: k('publish:readiness.fix.alreadySubmitted'),
  no_version: k('publish:readiness.fix.noVersion'),
  release_not_manual: k('publish:readiness.fix.releaseNotManual'),
  no_review_contact: k('publish:readiness.fix.noReviewContact'),
  no_review_demo_account: k('publish:readiness.fix.noReviewDemoAccount'),
  generic: k('publish:readiness.fix.generic'),
};

/** The codes only the store can tell after the push, by name. */
const UNKNOWN: Readonly<Record<string, string>> = {
  image_not_ready: k('publish:readiness.unknown.imageNotReady'),
  play_review_state_unknown: k('publish:readiness.unknown.playReviewState'),
};

export type ReadinessLine = {
  /** A stable key for a list. */
  id: string;
  code: string;
  /** The server's sentence (the same the submit would give). */
  message: string;
  locale: string | null;
  item: string | null;
  /** How to fix it, in the person's words. */
  fix: string;
  kind: ReadinessFixKind;
  /** The label of the link to the place it is fixed. Null: there is none (a push). */
  where: string | null;
  /** The place: a web address of Kiln (`#/portfolio/...`) or the store's own console. Null when there is none. */
  href: string | null;
  /** `href` is the store's console: opens in a new tab. */
  external: boolean;
  /** App Review Information (`kind` 'review'): the version it can be copied from, when the server named one; else null. */
  reviewFrom: string | null;
};

export type ReadinessView = {
  state: 'ready' | 'blocked';
  /** The number of blockers (0 when ready). */
  count: number;
  /** "Ready to submit for review" or "Submit would not run yet: 4 things to fix". */
  title: string;
  lines: ReadinessLine[];
  /** "Checked after the push: image processing." Null when nothing is only known later. */
  note: string | null;
  /** The staged push was merged into the store's draft to judge it (otherwise the draft is judged as the store holds it). */
  predicted: boolean;
  /** The plan asked for a submit that it left out (or blocked) because of these. */
  submitLeftOut: boolean;
};

const clean = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

const consoleUrl = (platform: Platform): string =>
  supports(platform, 'transactionalEdits') ? PLAY_CONSOLE_URL : APP_STORE_CONNECT_APPS_URL;

const whereLabel = (kind: ReadinessFixKind, platform: Platform): string | null => {
  switch (kind) {
    case 'listing':
      return t('publish:readiness.where.listing');
    case 'screenshots':
      return t('publish:readiness.where.screenshots');
    case 'notes':
      return t('publish:readiness.where.notes');
    case 'build':
      return t('publish:readiness.where.build');
    case 'review':
      return t('publish:readiness.where.reviewInformation');
    case 'store':
      return supports(platform, 'transactionalEdits')
        ? t('publish:readiness.where.playConsole')
        : t('publish:readiness.where.appStoreConnect');
    default:
      return null;
  }
};

/** One blocker as a line: the sentence, how to fix it, and where. */
export function readinessLine(platform: Platform, blocker: SubmitBlocker, index = 0): ReadinessLine {
  const known: FixCode = Object.prototype.hasOwnProperty.call(FIX, blocker.code)
    ? (blocker.code as FixCode)
    : 'generic';
  // The store's console is where a 'store' blocker and, when it cannot be copied, a 'review' blocker (App Review Information) is fixed.
  const inConsole = blocker.fix.kind === 'store' || blocker.fix.kind === 'review';
  const href = inConsole ? consoleUrl(platform) : (blocker.fix.href ?? null);
  return {
    id: `${blocker.code}:${blocker.locale ?? ''}:${blocker.item ?? ''}:${index}`,
    code: blocker.code,
    message: clean(blocker.message),
    locale: blocker.locale ?? null,
    item: blocker.item ?? null,
    fix: t(FIX[known]),
    kind: blocker.fix.kind,
    where: whereLabel(blocker.fix.kind, platform),
    href,
    external: inConsole,
    reviewFrom: reviewFromParam(blocker.params),
  };
}

/** The words for the codes only known after the push: "image processing". */
export function unknownNote(codes: readonly string[]): string | null {
  const items: string[] = [];
  for (const code of codes) {
    const key = UNKNOWN[code];
    if (key !== undefined) items.push(t(key));
  }
  return items.length === 0 ? null : t('publish:readiness.checkedAfter', { items: items.join(', ') });
}

/** The readiness of a plan (or of any source that carries it) as one view; null when the server said nothing (it is off, or the store could not be read). */
export function readinessView(source: {
  app: { platform: Platform };
  readiness?: PlanReadiness | null | undefined;
  steps?: readonly { type: string; requested: boolean; included: boolean; availability: string }[] | undefined;
}): ReadinessView | null {
  const submit = source.readiness?.submit;
  if (submit === undefined) return null;
  const platform = source.app.platform;
  const lines = submit.blockers.map((b, i) => readinessLine(platform, b, i));
  const left = (source.steps ?? []).some(
    (s) => (s.type === 'submit' || s.type === 'push_and_submit') && s.availability === 'blocked',
  );
  return {
    state: submit.ready ? 'ready' : 'blocked',
    count: lines.length,
    title: submit.ready
      ? t('publish:readiness.ready')
      : t('publish:readiness.blocked', { count: lines.length }),
    lines,
    note: unknownNote(submit.unknown),
    predicted: submit.predicted,
    submitLeftOut: left && !submit.ready,
  };
}

/** The number of certain blockers of a plan; 0 when it says nothing. */
export const blockerCount = (source: { readiness?: PlanReadiness | null | undefined }): number =>
  source.readiness?.submit.blockers.length ?? 0;

/**
 * The choice a person gets when a push and a submit were asked together and the submit certainly cannot run: push the draft only (fix the
 * blockers first, submit later), or fix the blockers first. Null: nothing to choose (nothing blocks, or the submit was not asked for).
 */
export function submitChoice(source: {
  readiness?: PlanReadiness | null | undefined;
  steps: readonly { type: string; requested: boolean; included: boolean; availability: string }[];
}): { count: number } | null {
  const count = blockerCount(source);
  if (count === 0) return null;
  const asked = source.steps.some(
    (s) =>
      (s.type === 'submit' || s.type === 'push_and_submit') &&
      s.requested &&
      !s.included &&
      s.availability === 'blocked',
  );
  return asked ? { count } : null;
}

/**
 * Where "Fix the blockers first" goes: the place of the first blocker that has one in Kiln, else the store's console. Null when no blocker
 * has a place (a push).
 */
export function firstFix(view: ReadinessView): { href: string; external: boolean } | null {
  for (const line of view.lines)
    if (line.href !== null && !line.external) return { href: line.href, external: false };
  for (const line of view.lines)
    if (line.href !== null) return { href: line.href, external: true };
  return null;
}

/** The sentence of a submit step that cannot be ticked: "Blocked: 4 things to fix before it can be submitted". */
export const blockedStepReason = (count: number): string =>
  t('publish:readiness.stepBlocked', { count });

/** The codes the server gives to the errors of a blocked submit step (they are listed once, in the readiness, not again under the step). */
export const isReadinessProblem = (code: string): boolean => code.indexOf('submit_blocked_') === 0;

/**
 * The stepper's checklist: the same blockers, each tied to the step of the stepper that fixes it (the texts of a locale are the Notes
 * step, a screenshot count the Assets step, the build the Build step). A blocker fixed outside the stepper (the store) has no step.
 */
export type StepperStep = 'build' | 'notes' | 'assets';
export type ChecklistItem = ReadinessLine & { step: StepperStep | null };

export function stepOfLine(line: Pick<ReadinessLine, 'kind'>): StepperStep | null {
  if (line.kind === 'listing' || line.kind === 'notes') return 'notes';
  if (line.kind === 'screenshots') return 'assets';
  if (line.kind === 'build') return 'build';
  return null;
}

export function checklist(view: ReadinessView): ChecklistItem[] {
  return view.lines.map((line) => ({ ...line, step: stepOfLine(line) }));
}

/** The text of the stepper's last button, so it says what will happen: with blockers the submit is not part of it. */
export function confirmButtonText(count: number, base: string): string {
  return count > 0 ? t('publish:readiness.confirmButtonBlocked', { count }) : base;
}
