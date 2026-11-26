import type { Platform, Role } from '@kiln/core';
import type { AttentionItem } from '../app-attention.ts';
import type { PlatformScope } from '../app-scope.ts';
import type { NextRow, NextStep } from '../next-step.ts';
import type { LastPublish, PublishStepType } from '../pending.ts';
import type { PromoteOption } from '../play-promote.ts';
import type { Publishing } from '../publishing.ts';
import type { AppPipeline } from '../release-pipeline.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';

/**
 * What is true about an app, as ONE pure answer (docs/state-model.md). `deriveAppState(facts, scope)` takes a plain snapshot of facts
 * (what the server said) and returns the phase, the words, the one primary action, the others, the badge of the top bar and a verdict
 * for every state-dependent action. Every screen reads this and nothing else: no screen decides "is a publish running", "how many
 * changes wait" or "may I promote" by itself. No DOM, no framework, no clock (`now` is a fact), no fetch. Written for the ES2017 web
 * build: no flatMap, no fromEntries.
 */

// ---------------------------------------------------------------------------------------------
// The facts

/** What waits to be published for ONE record (a platform of the app). */
export type PendingFacts = {
  /** The pending count: the length of the record's cart (`GET /pending/cart-summary`). The only count that is ever shown. */
  count: number;
  /** Of those, the items with an error (`GET /pending/summary`): a quality of the same count, never a second count. */
  blocking: number;
};

/** The plain snapshot the model is derived from. The store assembles it; a test writes it by hand. */
export type AppFacts = {
  role: Role;
  /** Every platform record of the app (not only those in scope). */
  records: readonly AppSummary[];
  /** By record id. A missing record has nothing pending. */
  pending: Readonly<Record<string, PendingFacts | undefined>>;
  /** Whether the pending counts were read at all (false: not known yet, the screens say nothing about it). */
  pendingKnown: boolean;
  /** By record id: the publish that runs now, or null. */
  publishing: Readonly<Record<string, Publishing | null | undefined>>;
  /**
   * By record id: the latest publish that did not complete (`dismissed` true once a person hid it), or null. The model ignores a
   * dismissed run and a run older than a publish that runs now.
   */
  lastRun: Readonly<Record<string, LastPublish | null | undefined>>;
  /** By record id: the releases the store reported (for what can be promoted). */
  releases: Readonly<Record<string, readonly ReleaseSummary[] | undefined>>;
  /** By record id: the release pipeline (what is in flight, in review, which build can be attached). */
  pipelines: Readonly<Record<string, Pick<AppPipeline, 'app' | 'pipeline'> | null | undefined>>;
  /** The rest of "Needs attention" (reviews, drift, failed CI...): shown by the release flow, never about pending or publishing. */
  attention: readonly AttentionItem[];
  /** The server's switch for publishing in one go; null when not known. */
  publishBatchEnabled: boolean | null;
  /** The time of the snapshot (the words say "started 3 minutes ago"). */
  now: number;
};

// ---------------------------------------------------------------------------------------------
// The answer

/** What an app is doing, from the most to the least urgent (the order is the priority). */
export const PHASES = [
  'publishing',
  'publish_failed',
  'changes_pending',
  'release_needs_you',
  'in_review',
  'release_running',
  'ready_to_release',
  'idle',
  /** The pending count is not read yet: nothing is said about "nothing is waiting". */
  'unknown',
] as const;
export type Phase = (typeof PHASES)[number];

/** The closed set of buttons the card, the top bar and the pending panels can offer as THE next thing to do. */
export const PRIMARY_ACTIONS = [
  'show_pending',
  'publish_again',
  'attach_build',
  'open_release',
  'prepare_release',
  'start_release',
  'promote',
  'follow_review',
  'none',
] as const;
export type PrimaryAction = (typeof PRIMARY_ACTIONS)[number];

/** Every action that changes something and depends on the state. Each has a verdict in `AppState.verdicts`. */
export const GUARDED_ACTIONS = [
  'publish',
  'push',
  'discard',
  'submit',
  'release',
  'promote',
  'create_version',
  'rollout',
  'prepare_release',
  'start_release',
] as const;
export type GuardedAction = (typeof GUARDED_ACTIONS)[number];

/** Why an action is off. `ok` when it is on. */
export type VerdictCode =
  | 'ok'
  | 'no_platform'
  | 'unsupported'
  | 'role'
  | 'publishing'
  | 'publish_failed'
  | 'nothing_to_publish'
  | 'switch_off';

export type Verdict = { enabled: boolean; code: VerdictCode; reason: string | null };

/** One button the model offers: what it does, whether it can be pressed now and, when it cannot, why. */
export type ActionOffer = {
  action: PrimaryAction;
  label: string;
  enabled: boolean;
  disabledReason: string | null;
  /** The record the action acts on (a publish of it running turns the button off). */
  appId: string | null;
  /** Where it goes; null for an action that opens a panel or a dialog (`show_pending`, `publish_again`, `start_release`, `prepare_release`). */
  href: string | null;
  /** `href` is the store's own page: opens in a new tab. */
  external: boolean;
};

/** What the top bar shows for the app that is open (and for a publish anywhere in the workspace). */
export type TopBarBadge =
  | { kind: 'idle' }
  | { kind: 'pending'; count: number; blocking: boolean }
  | { kind: 'publishing'; count: number; appId: string; elsewhere: boolean }
  | { kind: 'failed'; count: number; appId: string };

export type PlatformState = {
  platform: Platform;
  appId: string;
  name: string;
  phase: Phase;
  pending: PendingFacts;
  publishing: Publishing | null;
  /** The failure to show (undismissed, not older than a running publish), or null. */
  failure: LastPublish | null;
  /** The verdict of every guarded action for THIS record. */
  verdicts: Readonly<Record<GuardedAction, Verdict>>;
};

/** A row of the release flow (several releases on their way), with the verdict of its button. */
export type FlowRow = NextRow & { offer: ActionOffer };
export type FlowOther = {
  title: string;
  text: string;
  offer: ActionOffer;
};

/** The release flow as the card draws it: the release on its way and what else waits (the part that is not about pending or publishing). */
export type Flow = {
  step: NextStep;
  rows: FlowRow[];
  others: FlowOther[];
};

export type Promotion = {
  option: PromoteOption;
  offer: ActionOffer;
};

/** What is going on in the platforms that are NOT in scope (the page says where, in one quiet line). */
export type Elsewhere = {
  platforms: Platform[];
  pendingCount: number;
  publishing: boolean;
  failed: boolean;
};

export type AppState = {
  scope: PlatformScope;
  /** The platforms in scope, in the order of the records. */
  platforms: PlatformState[];
  phase: Phase;
  tone: 'neutral' | 'info' | 'warn' | 'bad';
  /** The words of the Next step card. */
  headline: string;
  reason: string;
  primaryAction: ActionOffer;
  secondaryActions: ActionOffer[];
  badge: TopBarBadge;
  /** The pending count in scope: THE number shown everywhere. */
  pendingCount: number;
  /** Of those, the items with an error. */
  blockingCount: number;
  pendingKnown: boolean;
  /** The records in scope whose publish runs now. */
  publishing: { appId: string; platform: Platform; name: string; entry: Publishing }[];
  /** The failures to show, in scope, one per record. */
  failures: { appId: string; platform: Platform; name: string; run: LastPublish }[];
  /** The release flow, or null while a phase above it (publishing, failed) speaks or when it has nothing of its own to say. */
  flow: Flow | null;
  /** The rest of "Needs attention" that the card does not already say (always the attention list, whatever the phase). */
  rest: AttentionItem[];
  /** A Google Play release in a testing track that can go to production: one offer, with its verdict (null when none or no right). */
  promotion: Promotion | null;
  elsewhere: Elsewhere;
  /** The verdict of an action over the whole scope: on only when it is on for every platform in scope that does it. */
  verdicts: Readonly<Record<GuardedAction, Verdict>>;
  /** The verdict of an action, for one platform when given (a record the scope does not hold is `no_platform`). */
  canDo(action: GuardedAction, platform?: Platform): Verdict;
};

/** A step list of a run is what "publish again" repeats. */
export type RunSteps = readonly PublishStepType[];
