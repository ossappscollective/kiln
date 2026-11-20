import {
  checkPlayProposal,
  fractionRefusalNotice,
  type PlayCheckContext,
  type PlayLocalCheck,
  type PlayProposal,
  type PlayStatus,
  playStateText,
  playStatusOf,
  type StagedChangesView,
} from '@mrm/core';
import type { EditableRelease } from './release-candidates.ts';
import { stagedField } from './release-stepper.ts';
import { percentText } from './store-release.ts';

/**
 * "Check with Google Play" (docs/adr/0025-play-release-checks.md): the request, the answer and the words. Google Play can only say
 * whether it would REFUSE a release (an error). Many warnings that Play Console shows (a missing deobfuscation file, the target API
 * level) are not available through the API, so a result must never say "no warnings". Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// The API

export type PlayCheckBody = {
  track: string;
  versionCodes: string[];
  releaseName?: string;
  status?: PlayStatus;
  userFraction?: number;
  notes?: { locale: string; text: string }[];
};

export type PlayCheckFinding = { stage: 'stage' | 'validate'; message: string };

export type PlayCheckAnswer = {
  store: 'googleplay';
  track: string;
  versionCodes: string[];
  status: PlayStatus;
  userFraction: number | null;
  outcome: 'no_errors' | 'errors';
  findings: PlayCheckFinding[];
  committed: false;
  checkedAt: number;
  note: string;
};

// ---------------------------------------------------------------------------------------------
// What is proposed

/** The share the person set as a fraction for the check, or null (none, or not a share). `0` and above `1` are kept so the local check can say why. */
export function fractionOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return isFinite(n) ? n : null;
}

/**
 * The release as it would be: `staged` puts what the person staged over what the store draft holds (the Confirm step: a push will
 * write it); `store` is the store draft only (the release dialog: a release starts what the store holds, not what is staged).
 */
export function proposalOf(input: {
  source: 'staged' | 'store';
  track: string;
  codes: readonly string[];
  fraction: number | null;
  view: StagedChangesView | null;
  editable: EditableRelease | null;
}): PlayProposal {
  const draft = input.editable && input.editable.store === 'googleplay' ? input.editable.draft : null;
  const staged = input.source === 'staged' ? input.view : null;
  const name = stagedField(staged, 'release_name');
  const notes: { locale: string; text: string }[] = [];
  const seen: Record<string, number> = {};
  for (const n of draft ? draft.notes : []) {
    seen[n.locale] = notes.length;
    notes.push({ locale: n.locale, text: n.text });
  }
  for (const r of staged ? (staged.release ?? []) : []) {
    if (r.field !== 'release_notes') continue;
    if (seen[r.locale] !== undefined) notes[seen[r.locale] as number] = { locale: r.locale, text: r.value };
    else notes.push({ locale: r.locale, text: r.value });
  }
  const codes = input.codes.length > 0 ? input.codes : draft ? draft.versionCodes : [];
  return {
    track: input.track,
    releaseName: name !== null ? name.value : (draft?.name ?? ''),
    versionCodes: [...codes],
    notes,
    userFraction: input.fraction,
  };
}

/** What the target track holds now (for "already live" and "lower than"), from the read of the draft and the other releases. */
export function contextOf(
  editable: EditableRelease | null,
  listingLocales: readonly string[],
): PlayCheckContext {
  const releases: PlayCheckContext['trackReleases'][number][] = [];
  if (editable && editable.store === 'googleplay') {
    if (editable.draft) releases.push(editable.draft);
    for (const other of editable.others) releases.push(other);
  }
  return { listingLocales, trackReleases: releases };
}

/** The local checks for a proposal; no store is asked. */
export const localChecks = (proposal: PlayProposal, context: PlayCheckContext): PlayLocalCheck[] =>
  checkPlayProposal(proposal, context);

/** The body of the request. A share that is not a valid share is left out (the local check says so); no share is a draft. */
export function checkBody(proposal: PlayProposal): PlayCheckBody {
  const fraction = proposal.userFraction;
  const valid = fraction !== null && fraction > 0 && fraction <= 1;
  const status = playStatusOf(valid ? fraction : null);
  return {
    track: proposal.track.trim(),
    versionCodes: [...proposal.versionCodes],
    ...(proposal.releaseName.trim() !== '' ? { releaseName: proposal.releaseName.trim() } : {}),
    status,
    ...(valid && fraction !== null ? { userFraction: fraction } : {}),
    notes: proposal.notes.filter((n) => n.text.trim() !== ''),
  };
}

/** A key for "this is what was checked": the result is old when the proposal is not the same any more. */
export const bodyKey = (body: PlayCheckBody): string => JSON.stringify(body);

/** Whether the check can be asked now, and if not why (never sends something Google would refuse for being incomplete). */
export function canCheck(proposal: PlayProposal): { ok: true } | { ok: false; reason: string } {
  if (proposal.track.trim() === '') return { ok: false, reason: 'Name the track first.' };
  if (proposal.versionCodes.length === 0)
    return { ok: false, reason: 'Choose the version codes first.' };
  const f = proposal.userFraction;
  if (f !== null && !(f > 0 && f <= 1))
    return { ok: false, reason: 'The share of users must be above 0% and at most 100%.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The words

/** What the release would be when it is checked: a draft, a rollout at a share, or everybody. */
export function stateLine(proposal: PlayProposal): string {
  const f = proposal.userFraction;
  const valid = f !== null && f > 0 && f <= 1;
  const status = playStatusOf(valid ? f : null);
  return playStateText(status, valid ? f : null, proposal.track.trim() || 'the track');
}

/** The sentence that must stay next to every "no errors": the API reports errors only. */
export const NO_ERRORS_SENTENCE =
  'Google found no errors. The Play Console may still show warnings: the API reports errors only, so notices such as a missing deobfuscation file or the target API level are not covered here.';
export const NOTHING_SAVED = 'Nothing was saved or released in Google Play.';

export type OutcomeView = {
  tone: 'ok' | 'bad';
  title: string;
  /** Plain sentences under the title. */
  lines: string[];
  findings: string[];
  /** Set when a finding is about the staged rollout (a share below 100%): what to do instead. Nothing is retried by itself. */
  rolloutNotice: string | null;
};

export function outcomeView(answer: PlayCheckAnswer): OutcomeView {
  if (answer.outcome === 'no_errors') {
    return {
      tone: 'ok',
      title: 'Google found no errors',
      lines: [NO_ERRORS_SENTENCE.replace(/^Google found no errors\. /, ''), NOTHING_SAVED],
      findings: [],
      rolloutNotice: null,
    };
  }
  const n = answer.findings.length;
  return {
    tone: 'bad',
    title: n === 1 ? 'Google reported an error' : `Google reported ${n} errors`,
    lines: ['Fix this before you release. Google Play would refuse the release as it is.', NOTHING_SAVED],
    findings: answer.findings.map((f) => f.message),
    rolloutNotice:
      answer.findings.map((f) => fractionRefusalNotice(f.message, answer.userFraction ?? null)).find((n) => n !== null) ?? null,
  };
}

/** "This check was made for 10%, as a rollout in production, codes 241." */
export function checkedLine(answer: PlayCheckAnswer): string {
  const how =
    answer.status === 'draft'
      ? 'as a draft'
      : answer.status === 'completed'
        ? 'for everybody (100%)'
        : `as a rollout to ${percentText(answer.userFraction ?? 0)}`;
  return `Checked ${how} in ${answer.track}, version code${answer.versionCodes.length === 1 ? '' : 's'} ${answer.versionCodes.join(', ')}.`;
}
