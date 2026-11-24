/**
 * "Store assets changed in the repository" (docs/adr/0063-release-asset-proposal.md): when a release is prepared, the listing texts and graphics
 * that changed in the repository since the previous release, and still differ from the store and from the cart, are PROPOSED for staging.
 * The shapes below are what the server answers and the web shows; the helpers are pure so both sides agree on ids, counts and defaults.
 * The web target is ES2017: no `flatMap` or `fromEntries`.
 */

import type { Platform } from '../platform.ts';
import type { AssetKind } from '../listing/store-asset-specs.ts';

export type ProposalSeverity = 'error' | 'warning' | 'tip';

/** Where a finding comes from: the listing checks of the Insights page, the listing limits, or the graphics rules of the Graphics tab. */
export type ProposalIssueSource = 'listing_check' | 'listing_rule' | 'graphics_rule';

export type ProposalIssue = {
  /** Stable for one finding: `<itemId>:<source>:<code>[:<path>]`. */
  id: string;
  /** The item the finding is about; null for a finding about the whole locale. */
  itemId: string | null;
  source: ProposalIssueSource;
  severity: ProposalSeverity;
  code: string;
  locale: string | null;
  /** A listing field id (texts), or a file path (graphics). */
  field: string | null;
  /** Numbers for the sentence (`used`, `limit`, `unit`, ...). */
  params: Record<string, string | number>;
  /** The documented rule in English, for the findings that have no translated sentence (`listing_rule`, `graphics_rule`). */
  message: string | null;
};

export type ProposalFile = {
  path: string;
  oid: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
};

/** An image the store holds for a set: `ref` is the opaque id of the store thumbnail proxy (`GET .../assets/store/thumb?ref=`), never a store address. */
export type ProposalStoreFile = {
  ref: string;
  position: number;
  name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

export type ProposalText = {
  id: string;
  kind: 'text';
  locale: string;
  field: string;
  /** The store's text now (the editable version's where there is one), null when the store has none. */
  before: string | null;
  /** The repository's text at the release's source. */
  after: string;
  hasErrors: boolean;
};

export type ProposalGraphics = {
  id: string;
  kind: 'graphics';
  locale: string;
  /** `slotKey` of the set: `screenshot:iphone_6_5`, `feature_graphic`. */
  slot: string;
  slotKind: AssetKind;
  device: string | null;
  deviceLabel: string;
  /** Files the store holds in this set now; null when the store was not read. */
  before: number | null;
  /** The images the store holds for the set now (for the image comparison); absent when the store was not read. */
  beforeFiles?: ProposalStoreFile[];
  after: { count: number; commit: string; files: ProposalFile[] };
  hasErrors: boolean;
};

export type ProposalItem = ProposalText | ProposalGraphics;

/** An item that is in the cart already: `same` holds the value of the repository, `edited` was changed by a person and is never overwritten. */
export type ProposalStaged = {
  id: string;
  kind: 'text' | 'graphics';
  locale: string;
  field: string;
  state: 'same' | 'edited';
};

export type ProposalRef = {
  sha: string;
  source: 'build' | 'default_branch' | 'previous_build' | 'repo_snapshot';
};

export type ProposalState = { state: 'open' | 'skipped' | 'later'; at: number | null };

export type ProposalUnavailable = 'no_repository' | 'no_repo_metadata' | 'target_unreadable';

export type AssetProposalView = {
  appId: string;
  platform: Platform;
  version: string | null;
  /** Null when the repository cannot be used (`reason`), otherwise the proposal even when nothing changed. */
  unavailable: ProposalUnavailable | null;
  state: ProposalState;
  /** Apple with no editable version: shown, but nothing can be staged until a new version is prepared. */
  locked: { locked: boolean; reason: string | null; liveVersion: string | null };
  baseRef: ProposalRef | null;
  targetRef: ProposalRef | null;
  /** No previous release (or its source cannot be read): everything that differs from the store is a candidate. */
  noPreviousRelease: boolean;
  /** The store's graphics could not be read: graphics are proposed by the repository's change alone. */
  storeUnread: boolean;
  changes: ProposalItem[];
  alreadyStaged: ProposalStaged[];
  issues: ProposalIssue[];
  summary: ProposalSummary;
  skipped: { unchangedSinceRelease: number; sameAsStore: number; notStageable: number };
  notes: string[];
};

export type ProposalSummary = {
  texts: number;
  locales: number;
  graphics: number;
  errors: number;
  warnings: number;
  tips: number;
};

export const textItemId = (locale: string, field: string): string => `text:${locale}:${field}`;
export const graphicsItemId = (locale: string, slot: string): string =>
  `graphics:${locale}:${slot}`;

const ORDER: Record<ProposalSeverity, number> = { error: 0, warning: 1, tip: 2 };

/** Errors first, then warnings, then tips; within a severity the order they were found in. */
export function orderIssues(issues: readonly ProposalIssue[]): ProposalIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => ORDER[a.issue.severity] - ORDER[b.issue.severity] || a.i - b.i)
    .map((x) => x.issue);
}

export function summarizeProposal(
  changes: readonly ProposalItem[],
  issues: readonly ProposalIssue[],
): ProposalSummary {
  const locales: Record<string, true> = {};
  let texts = 0;
  let graphics = 0;
  for (const c of changes) {
    locales[c.locale] = true;
    if (c.kind === 'text') texts += 1;
    else graphics += 1;
  }
  let errors = 0;
  let warnings = 0;
  let tips = 0;
  for (const i of issues) {
    if (i.severity === 'error') errors += 1;
    else if (i.severity === 'warning') warnings += 1;
    else tips += 1;
  }
  return { texts, locales: Object.keys(locales).length, graphics, errors, warnings, tips };
}

/** The items checked when the card opens: those without errors. An item with errors can be selected, after an explicit confirmation. */
export const defaultSelection = (changes: readonly ProposalItem[]): string[] =>
  changes.filter((c) => !c.hasErrors).map((c) => c.id);

/** Of the selected ids, those that have errors (the person confirms these before they are staged). */
export function selectedWithErrors(
  changes: readonly ProposalItem[],
  selected: readonly string[],
): string[] {
  const picked: Record<string, true> = {};
  for (const id of selected) picked[id] = true;
  return changes.filter((c) => c.hasErrors && picked[c.id]).map((c) => c.id);
}
