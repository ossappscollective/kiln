import { createHash } from 'node:crypto';
import { type Platform, supports, versionCodesOf } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { cleanParams, coded, codingOf } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  loadPendingFacts,
  type PendingItem,
  PUBLISH_STEPS,
  type PublishStep,
  pendingItemsOf,
  totalsOf,
} from './pending.ts';
import {
  changesInReviewBefore,
  draftRefusedBefore,
  type LastPublish,
  type RunOutcome,
  type RunStep,
  recordRun,
} from './publish-runs.ts';
import {
  type ClaimKey,
  DEFAULT_PUBLISH_CLAIM_TTL_MS,
  DEFAULT_PUBLISH_HEARTBEAT_MS,
  DETAIL_PHASES,
  type DetailPhase,
  isLiveClaim,
  PROCESS_ID,
  publishInProgress,
  reapDeadClaims,
  recordDetail,
  recordHeartbeat,
  recordStep,
  recordSteps,
} from './publishing.ts';
import {
  applyDraftPush,
  DRAFT_ENV,
  type DraftContext,
  type DraftPreview,
  previewDraftPush,
} from './store-draft.ts';
import { loadPush } from './store-draft-record.ts';
import { MESSAGE_MAX, type StoreFacts, sanitiseStoreText } from './store-failure.ts';
import {
  applyRelease,
  confirmationPhraseOf,
  previewRelease,
  RELEASE_ENV,
  type ReleaseContext,
  type ReleaseInput,
  requestOfInput,
  resolveDirect,
} from './store-release.ts';
import {
  applyRollout,
  previewRollout,
  ROLLOUT_ENV,
  type RolloutContext,
  type RolloutRequest,
} from './store-rollout.ts';
import {
  applySubmit,
  confirmationPhrase,
  previewSubmit,
  SUBMIT_ENV,
  type SubmitContext,
} from './store-submit.ts';

/**
 * The BATCH PUBLISH of an app: one plan, ONE final confirmation, several gated store steps in order
 * (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md).
 *
 * It adds no power of its own. Every step is run by the SERVICE THAT ALREADY RUNS IT (`applyDraftPush`, `applySubmit`,
 * `applyRelease`, `applyRollout`), so each step keeps its own switch, its own role right, its own claim, its own re-read of the
 * store right before the write, its own refusal on drift (`state_changed`), its own never-retry rule and its own read-back of a lost
 * answer. The plan only COMBINES their previews:
 *
 * - `buildPlan` previews each requested step with the step's own preview function and collects availability (switch off, right
 *   missing, nothing to do, blocked by errors, needs input), the individual preview, its confirmHash and, for submit and release, the
 *   phrase the step's own gate asks for. `planHash` covers the included steps, their requests, their confirmHashes and their phrases.
 * - ONE typed phrase (`publish <app name> <n> steps`) is required when any included step is irreversible (submit, release) or changes
 *   what live users receive (rollout). It covers exactly the steps the plan lists: the plan hash binds them, so the phrase of one
 *   plan cannot be reused for another. The batch passes each step the phrase that step's own preview promised, and no other.
 * - A step that depends on an earlier step of the same batch (submit needs the pushed draft; a release that follows a push) cannot be
 *   previewed before that step ran. It is `deferred`: the plan carries a PROMISE (what the step will do, and its phrase). After the
 *   earlier steps applied, the step is previewed again with the step's own preview function; if its summary or phrase differs from the
 *   promise it is SKIPPED with `plan_drifted` (nothing is written) and the person reviews again; if the preview blocks it is skipped
 *   as `blocked`. Only a preview that matches the promise is applied, with the confirmHash that preview just produced.
 * - Steps run in order and stop at the first one that is not applied; the rest are `skipped` (`previous_step_not_applied`). Nothing is
 *   retried: an unknown outcome was already read back by the step's service and is reported as `outcome: 'unknown'`.
 * - One batch in flight per app and platform (`store_publish_claims`, migration 29).
 * - Audit (`pending.published`) and the event `pending.published` hold ids, counts, hashes and per-step outcomes. Never a text.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const PUBLISH_ENV = 'KILN_STORE_PUBLISH_BATCH_ENABLED';
export const PUBLISH_ACTION = 'store.publish';
/** A claim whose heartbeat is older than this is a dead process (`publishing.ts`): a running batch renews it by a timer, also inside a step. */
export { DEFAULT_PUBLISH_CLAIM_TTL_MS, DEFAULT_PUBLISH_HEARTBEAT_MS };
/** The least time between two lines of "what the step is doing" written to the claim (a screen polls every few seconds). */
export const DETAIL_THROTTLE_MS = 2_000;
/**
 * The longest one step of a batch may run before the batch gives up waiting for it and answers (a backstop over the step's own
 * timeouts: a push is bounded by four minutes and the check after it, a submit by two and the check after it). The answer is an
 * unknown outcome: the step is never retried, and the person is told to look.
 */
export const DEFAULT_PUBLISH_STEP_TIMEOUT_MS = 480_000;

export const STEP_ACTION = {
  push_draft: 'store.push_draft',
  /** The combined step needs this right AND `store.push_draft` (and both switches): see `COMBINED_ALSO`. */
  push_and_submit: 'store.submit',
  submit: 'store.submit',
  release: 'store.release',
  rollout: 'releases.rollout',
} as const;
export const STEP_ENV = {
  push_draft: DRAFT_ENV,
  push_and_submit: SUBMIT_ENV,
  submit: SUBMIT_ENV,
  release: RELEASE_ENV,
  rollout: ROLLOUT_ENV,
} as const;
/** The combined step is the push AND the submit: it also needs the push's right and switch. */
const COMBINED_ALSO = { action: 'store.push_draft', envName: DRAFT_ENV } as const;
const STEP_LABEL = {
  push_draft: 'Push the staged changes to the store as a draft',
  push_and_submit: 'Push the staged changes and send them for store review in one step',
  submit: 'Submit the draft for store review',
  release: 'Release',
  rollout: 'Change the rollout',
} as const;
/** Steps that cannot be taken back, or change what live users receive: they need the typed phrase. */
const IRREVERSIBLE: Record<PublishStep, boolean> = {
  push_draft: false,
  push_and_submit: true,
  submit: true,
  release: true,
  rollout: true,
};

export type PublishContext = {
  db: Database;
  now: () => number;
  /** KILN_STORE_PUBLISH_BATCH_ENABLED. Turns no step on: each step's own switch decides. */
  publishEnabled: boolean;
  draft: DraftContext;
  submit: SubmitContext;
  release: ReleaseContext;
  rollout: RolloutContext;
  claimTtlMs?: number;
  /** How often a running batch renews its heartbeat (default `DEFAULT_PUBLISH_HEARTBEAT_MS`). */
  heartbeatMs?: number;
  /** The longest one step may run (default `DEFAULT_PUBLISH_STEP_TIMEOUT_MS`). */
  stepTimeoutMs?: number;
  /**
   * One line to the server log per boundary of a batch (started, each step started and ended with how long it took, finished). Ids,
   * step names, statuses and error codes; a failed step adds its HTTP status and the store's own sentence, SANITISED and cut to 200
   * characters (`store-failure.ts`: no credential, no token-shaped string). Never a request or an upload. Default: silent.
   */
  log?: (line: string) => void;
};

/** What the caller may do, per step: the role right of the session, or the token's list. The route computes it. */
export type PublishRights = Record<PublishStep, boolean>;

// ---------------------------------------------------------------------------------------------
// Requests

export type StepRequest = {
  type: PublishStep;
  /** Rollout: the change (`set_fraction`, `halt`, `resume`, `complete`, `pause`, `release_to_all`). */
  action?: string | undefined;
  /** App Store: the marketing version (release, rollout). */
  version?: string | undefined;
  /** Google Play (release, rollout). */
  track?: string | undefined;
  versionCodes?: string[] | undefined;
  /** Google Play release (required, never implied) and rollout `set_fraction`. */
  userFraction?: number | undefined;
  /** Google Play release: release the staged fields in ONE step, no draft first (docs/adr/0029-direct-play-release.md). */
  direct?: boolean | undefined;
  /**
   * Google Play, `push_and_submit` only: replace the review that is in progress with everything together (the commit uses
   * `changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT`). Only a person's explicit choice after `changes_in_review`; never implied.
   */
  replaceReview?: boolean | undefined;
};

const FIELDS: Record<PublishStep, readonly (keyof StepRequest)[]> = {
  push_draft: [],
  push_and_submit: ['replaceReview'],
  submit: [],
  release: ['version', 'track', 'versionCodes', 'userFraction', 'direct'],
  rollout: ['action', 'version', 'track', 'versionCodes', 'userFraction'],
};

/**
 * The combined step is the push and the submit in one commit, so it needs BOTH rights (`store.push_draft` and `store.submit`): the
 * caller's rights for it are computed here from the two, whatever the caller said about it.
 */
export const withCombinedRight = (rights: PublishRights, withRelease = false): PublishRights => ({
  ...rights,
  // With the release in the same commit (`one commit`), the release is what Google reviews: the step needs the release's right, not the submit's.
  push_and_submit: rights.push_draft && (withRelease ? rights.release : rights.submit),
});

const invalidSteps = (message: string, extra: Record<string, unknown> = {}): Failure =>
  failure(422, 'invalid_steps', message, extra);

/** One step of each kind, only the fields that kind takes, in the order they run. */
export function normalizeSteps(
  requests: readonly StepRequest[],
): { ok: true; steps: StepRequest[] } | Failure {
  const seen = new Set<PublishStep>();
  const out: StepRequest[] = [];
  for (const r of requests) {
    if (!PUBLISH_STEPS.includes(r.type))
      return invalidSteps(`type must be one of ${PUBLISH_STEPS.join(', ')}.`);
    if (seen.has(r.type))
      return invalidSteps(`There can be one ${r.type} step in a batch.`, { type: r.type });
    seen.add(r.type);
    const allowed = FIELDS[r.type];
    for (const key of Object.keys(r) as (keyof StepRequest)[]) {
      if (key === 'type' || r[key] === undefined) continue;
      if (!allowed.includes(key))
        return invalidSteps(`A ${r.type} step does not take ${key}.`, { type: r.type, field: key });
    }
    if (r.type === 'rollout' && (r.action === undefined || r.action === ''))
      return invalidSteps('A rollout step needs the action to take.', {
        type: r.type,
        field: 'action',
      });
    const clean: StepRequest = { type: r.type };
    for (const key of allowed) {
      const v = r[key];
      if (v === undefined) continue;
      (clean as Record<string, unknown>)[key] = Array.isArray(v) ? [...v].sort() : v;
    }
    out.push(clean);
  }
  out.sort((a, b) => PUBLISH_STEPS.indexOf(a.type) - PUBLISH_STEPS.indexOf(b.type));
  return { ok: true, steps: out };
}

const needsPhrase = (types: readonly PublishStep[]) => types.some((t) => IRREVERSIBLE[t]);

/** The text a person types once for the whole batch. Needs no store read, so a wrong one is refused before anything else. */
export const publishPhrase = (app: Pick<ManagedApp, 'name'>, steps: number): string =>
  `publish ${app.name} ${steps} ${steps === 1 ? 'step' : 'steps'}`;

// ---------------------------------------------------------------------------------------------
// The plan

export type PlanProblem = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  item?: string;
};

export type Availability =
  | 'available'
  | 'feature_disabled'
  | 'forbidden'
  | 'nothing_to_do'
  | 'blocked'
  | 'needs_input'
  | 'not_requested';

export type PlanStep = {
  type: PublishStep;
  platform: Platform;
  /** 1 to 4: the order the steps run in. */
  order: number;
  label: string;
  /** The person named this step in `steps`. With no `steps`, every available step is included and none is "requested". */
  requested: boolean;
  /** Part of the plan: available, and asked for (or chosen automatically). Only these run. */
  included: boolean;
  availability: Availability;
  /** Why it is not available, in a sentence (null when available). */
  reason: string | null;
  /** The right and the switch this step needs, and whether they hold now. */
  requires: { action: string; envName: string; enabled: boolean; allowed: boolean };
  /** True for submit, release and rollout: the plan needs the typed phrase. */
  irreversible: boolean;
  /** Previewed again after the earlier steps applied; `summary` is then a promise it must keep. */
  deferred: boolean;
  /** What the step will do, in numbers and ids. Part of the plan hash. */
  summary: Record<string, unknown> | null;
  /** What to send back for this step (the request the plan was made from). */
  request: StepRequest | null;
  /** The preview the step's own route would give (null for a deferred step that cannot be previewed yet). */
  preview: unknown;
  confirmHash: string | null;
  /** The phrase the step's own gate asks for. The batch phrase stands in for it; shown so the person can see what is released. */
  stepPhrase: string | null;
  problems: PlanProblem[];
};

export type PublishPlan = {
  app: { id: string; name: string; platform: Platform; store: string };
  steps: PlanStep[];
  /** The steps to send back to `POST .../publish`: the included ones, as requests. */
  publishSteps: StepRequest[];
  included: number;
  irreversible: boolean;
  irreversibleSteps: PublishStep[];
  warnings: string[];
  /** Every requested step is available, and at least one is included. */
  confirmable: boolean;
  /** Null while the plan is not confirmable. */
  planHash: string | null;
  /** Whether `phrase` must be sent. */
  confirmationRequired: boolean;
  /** The one phrase to type (null when none is required or the plan is not confirmable). */
  confirmation: { phrase: string; instruction: string } | null;
  /**
   * Google Play: what the staged release fields name (track, version codes, the share staged as an intention), when a release can
   * be made from them in one step. Null: nothing like that is staged, or not Google Play. Never a note.
   */
  direct: { track: string; versionCodes: string[]; stagedFraction: number | null } | null;
  /** The plan was made as ONE direct release step because only release fields are staged (push draft and submit are left out). */
  defaultedToDirect: boolean;
  /**
   * Google Play: the push, the send for review and the release are ONE edit and ONE commit (a `push_and_submit` and a `release` named
   * together). The `push_and_submit` step carries the whole content (see its `summary.release`); the `release` step runs nothing of its own.
   */
  oneCommit: boolean;
  /** The commit replaces the review in progress with everything together (`CANCEL_IN_REVIEW_AND_SUBMIT`): chosen by the person, never implied. */
  replacesReview: boolean;
  /**
   * Google Play: this app's last run was refused because changes were already in review (`changes_in_review`). A hint from the kept runs,
   * not a read of Google Play (its API shows no review state): the recommended plan then names the replacing variant, which still runs
   * only when the person confirms it.
   */
  changesInReview: boolean;
  /**
   * Google Play: the push and the submit as ONE step (`push_and_submit`). `offered`: the plan lists it as an alternative to the pair
   * (Google may refuse to keep a draft for this app, and the plan cannot know before trying). `draftRefused`: the last run of this app
   * was refused a draft by Google (`draft_not_allowed`) and no draft push went through since. `defaulted`: no `steps` were sent and
   * `draftRefused` holds, so the plan was made with this step in place of the pair; the pair stays selectable.
   */
  combined: { offered: boolean; draftRefused: boolean; defaulted: boolean };
  /**
   * Google Play, a build that is released (`direct` is not null): where the build comes from, as the last store sync saw it. `from`
   * is another track of the app that holds ALL the version codes (a promotion: "from internal to production"); `version` is the
   * version name of the build when a synced store build has one. Both null when the sync does not say. Null: no such build is staged.
   */
  promotion: { from: string | null; version: string | null } | null;
  /**
   * The ONE step (or pair) this plan recommends, so a person never meets an empty plan while a valid step exists (see
   * `recommendationOf`). `steps` are the requests to send back to the preview: a release has no share in it (the share is the
   * person's, never implied: `needsShare`). Null: nothing valid to recommend (nothing staged, a step blocked by errors, switches off).
   */
  recommended: PlanRecommendation | null;
  readAt: number;
};

export type RecommendedWhy =
  /** A build is released to a track with nothing else staged: ONE direct release, sent to Google for review, no draft. */
  | 'promotion'
  /** Same, but the sync does not show the build in another track. */
  | 'direct_release'
  /**
   * Staged texts or graphics AND a staged release: ONE edit, ONE commit that pushes them and releases the build, sent to Google for
   * review together (`push_and_submit` + `release` named together are one step). Two commits would be refused by Google.
   */
  | 'one_commit'
  /** Google refused to keep a draft for this app the last time: push and send for review in one step. */
  | 'draft_refused'
  /** Staged texts or graphics: the push (a draft), as before. */
  | 'draft'
  /** Any other platform: the steps the plan itself included. */
  | 'default';

export type PlanRecommendation = {
  types: PublishStep[];
  steps: StepRequest[];
  why: RecommendedWhy;
  /** The release in `steps` still needs the share of users from the person (the server never implies one). */
  needsShare: boolean;
  /** The recommended step replaces the review in progress (`replaceReview` on the push): only after a `changes_in_review` refusal. */
  replacesReview: boolean;
};

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type Check = { code: string; message: string; item?: string | undefined };

const problemsFromChecks = (checks: { blocking: Check[]; warnings: Check[] }): PlanProblem[] => [
  ...checks.blocking.slice(0, 30).map(
    (c): PlanProblem => ({
      code: c.code,
      severity: 'error',
      message: c.message,
      ...(c.item !== undefined ? { item: c.item } : {}),
    }),
  ),
  ...checks.warnings.slice(0, 30).map(
    (c): PlanProblem => ({
      code: c.code,
      severity: 'warning',
      message: c.message,
      ...(c.item !== undefined ? { item: c.item } : {}),
    }),
  ),
];

const messageOf = (f: Failure): string =>
  typeof f.body.message === 'string' ? f.body.message : f.body.error;

const problemOfFailure = (f: Failure): PlanProblem[] => {
  const listed = Array.isArray(f.body.problems)
    ? (f.body.problems as { code?: unknown; message?: unknown; item?: unknown }[])
    : [];
  if (listed.length > 0) {
    return listed.slice(0, 30).map((p) => ({
      code: String(p.code ?? f.body.error),
      severity: 'error' as const,
      message: String(p.message ?? ''),
      ...(p.item !== undefined ? { item: String(p.item) } : {}),
    }));
  }
  return [{ code: f.body.error, severity: 'error', message: messageOf(f) }];
};

type Evaluation = Pick<
  PlanStep,
  | 'availability'
  | 'reason'
  | 'deferred'
  | 'summary'
  | 'preview'
  | 'confirmHash'
  | 'stepPhrase'
  | 'problems'
>;

const unavailable = (
  availability: Exclude<Availability, 'available'>,
  reason: string,
  problems: PlanProblem[] = [],
  preview: unknown = null,
): Evaluation => ({
  availability,
  reason,
  deferred: false,
  summary: null,
  preview,
  confirmHash: null,
  stepPhrase: null,
  problems,
});

/** What the push promises the submit that follows it: the items its record will hold, counted like the record counts them. */
async function recordAfterPush(
  sql: Sql,
  app: ManagedApp,
  push: DraftPreview,
): Promise<{ texts: number; assetSets: number; versionString: string | null }> {
  const record = await loadPush(sql, app.id, app.platform);
  const sameVersion =
    record !== undefined && (record.versionId ?? null) === (push.version?.id ?? null);
  const texts = new Set<string>(push.text.map((t) => `${t.locale}|${t.field}`));
  const sets = new Set<string>(push.assets.map((a) => `${a.locale}|${a.slotKey}`));
  if (sameVersion && record) {
    for (const t of record.manifest.text) texts.add(`${t.locale}|${t.field}`);
    for (const a of record.manifest.assets) sets.add(`${a.locale}|${a.key}`);
  }
  return {
    texts: texts.size,
    assetSets: sets.size,
    versionString:
      push.version?.versionString ?? (sameVersion ? (record?.versionString ?? null) : null),
  };
}

/**
 * Google Play: the staged release fields of the app, for the direct release. `unpushed` counts what a draft push would still write
 * (texts, graphics, release fields). The intended share (`user_fraction`) is local only and not counted.
 */
async function stagedForDirect(
  sql: Sql,
  app: ManagedApp,
): Promise<{
  texts: number;
  assets: number;
  fields: number;
  track: string | null;
  codes: string[];
  fraction: number | null;
}> {
  const rows = await sql.query(
    'SELECT kind, target, value_text, value_hash, pushed_hash FROM staged_changes WHERE app_id = ?',
    [app.id],
  );
  const out = {
    texts: 0,
    assets: 0,
    fields: 0,
    track: null as string | null,
    codes: [] as string[],
    fraction: null as number | null,
  };
  for (const r of rows) {
    const kind = String(r.kind);
    const target = String(r.target);
    const unpushed =
      r.pushed_hash === null ||
      r.pushed_hash === undefined ||
      String(r.pushed_hash) !== String(r.value_hash);
    if (kind === 'release_field') {
      if (target === 'track') out.track = String(r.value_text);
      else if (target === 'version_codes') out.codes = versionCodesOf(String(r.value_text));
      else if (target === 'user_fraction') {
        const n = Number(r.value_text);
        out.fraction = Number.isFinite(n) ? n : null;
      }
      if (target !== 'user_fraction' && unpushed) out.fields++;
    } else if (unpushed) {
      if (kind === 'listing_text') out.texts++;
      else out.assets++;
    }
  }
  return out;
}

/**
 * Google Play: where the staged build comes from, as the last store sync saw it (`app_releases`, `app_builds`): another track that
 * holds ALL its version codes (the build is promoted from there), and the version name a synced build gives. Reads our own database
 * only; never a guess: a track the sync did not show, or a build with no version name, gives null.
 */
export async function promotionOf(
  sql: Sql,
  app: Pick<ManagedApp, 'id' | 'platform'>,
  hint: { track: string; versionCodes: readonly string[] },
): Promise<{ from: string | null; version: string | null }> {
  const wanted = hint.versionCodes.map(String);
  let from: string | null = null;
  const rows = await sql.query(
    'SELECT track, details_json FROM app_releases WHERE app_id = ? AND platform = ? ORDER BY track',
    [app.id, app.platform],
  );
  for (const r of rows) {
    const track = String(r.track ?? '');
    if (track === '' || track === hint.track) continue;
    let codes: string[] = [];
    try {
      const d = JSON.parse(String(r.details_json ?? '{}')) as { versionCodes?: unknown };
      codes = Array.isArray(d.versionCodes) ? d.versionCodes.map(String) : [];
    } catch {
      codes = [];
    }
    if (wanted.length > 0 && wanted.every((c) => codes.includes(c))) {
      from = track;
      break;
    }
  }
  let version: string | null = null;
  for (const code of wanted) {
    const builds = await sql.query(
      'SELECT version FROM app_builds WHERE app_id = ? AND platform = ? AND build_number = ?',
      [app.id, app.platform, code],
    );
    const v = String(builds[0]?.version ?? '').trim();
    if (v !== '') {
      version = v;
      break;
    }
  }
  return { from, version };
}

/**
 * What to recommend, from the facts alone (pure: the unit tests drive it). The person's intent decides, never a leftover of how the
 * dialog was opened:
 * - a build staged for a track and NOTHING else (no listing text, no graphics): they want it released. The one step that does that
 *   is the direct release: one Play edit that makes the release (status `completed`, or `inProgress` with the share) and commits it
 *   without the hold-back, so Google reviews it. A draft would only park it. `promotion` when the sync shows the build in another track.
 * - staged texts or graphics, and Google refused a draft for this app last time: the push and the submit as one step.
 * - staged texts or graphics otherwise: the push (a draft), as before.
 * A step whose switch is off, whose right is missing or that the plan found unavailable is never recommended; none left: null.
 */
export function recommendationOf(input: {
  google: boolean;
  /** What is staged: null when the platform has no staged release fields (nothing to know). */
  staged: { texts: number; assets: number; fields: number } | null;
  direct: { track: string; versionCodes: string[] } | null;
  from: string | null;
  draftRefused: boolean;
  /** Can the step run: its switch is on and the caller has the right. */
  can: Record<PublishStep, boolean>;
  /** The push and the release in ONE commit can run: the push's and the release's switches are on and the caller has both rights. */
  canOneCommit?: boolean;
  /** The last run of this app was refused because changes were in review. */
  changesInReview?: boolean;
  /** The plan found the step unavailable (only for a step that was evaluated). */
  unavailable: Partial<Record<PublishStep, boolean>>;
  /** The plan's own choice when nothing special applies (non-Google): the included steps. */
  included: PublishStep[];
}): PlanRecommendation | null {
  const { staged, direct } = input;
  if (!input.google || staged === null) {
    return input.included.length === 0
      ? null
      : {
          types: input.included,
          steps: input.included.map((type) => ({ type })),
          why: 'default',
          needsShare: false,
          replacesReview: false,
        };
  }
  const listing = staged.texts + staged.assets;
  const replaces = input.changesInReview === true;
  const oneCommit = (): PlanRecommendation | null =>
    direct !== null &&
    input.canOneCommit === true &&
    !input.unavailable.release &&
    !input.unavailable.push_and_submit
      ? {
          types: ['push_and_submit', 'release'],
          steps: [
            { type: 'push_and_submit', ...(replaces ? { replaceReview: true } : {}) },
            { type: 'release', track: direct.track, versionCodes: direct.versionCodes },
          ],
          why: 'one_commit',
          needsShare: true,
          replacesReview: replaces,
        }
      : null;
  // After a refusal for changes in review, even a release alone is recommended as the one commit that replaces the review.
  if (replaces && listing === 0 && direct !== null) {
    const again = oneCommit();
    if (again !== null) return again;
  }
  if (direct !== null && listing === 0 && input.can.release && !input.unavailable.release) {
    return {
      types: ['release'],
      steps: [
        { type: 'release', direct: true, track: direct.track, versionCodes: direct.versionCodes },
      ],
      why: input.from !== null ? 'promotion' : 'direct_release',
      needsShare: true,
      replacesReview: false,
    };
  }
  if (listing > 0) {
    const once = oneCommit();
    if (once !== null) return once;
  }
  if (listing + staged.fields === 0) return null;
  if (
    input.draftRefused &&
    listing > 0 &&
    input.can.push_and_submit &&
    !input.unavailable.push_and_submit
  )
    return {
      types: ['push_and_submit'],
      steps: [{ type: 'push_and_submit' }],
      why: 'draft_refused',
      needsShare: false,
      replacesReview: false,
    };
  if (input.can.push_draft && !input.unavailable.push_draft)
    return {
      types: ['push_draft'],
      steps: [{ type: 'push_draft' }],
      why: 'draft',
      needsShare: false,
      replacesReview: false,
    };
  return null;
}

const RELEASE_DEFERRABLE = ['no_draft_release', 'version_codes_not_uploaded'];

type Done = Partial<Record<PublishStep, PlanStep>>;

/**
 * The plan of a batch: each requested step previewed by its own preview function (or promised, when it depends on an earlier step).
 * `steps` undefined: every step that is available and has work is included. Reads the store through the steps' previews; writes nothing.
 */
export async function buildPlan(
  ctx: PublishContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    steps?: readonly StepRequest[] | undefined;
    rights: PublishRights;
    /** A person's own confirmation (step-up) stands in for the typed phrase (see `stepUpCovers`). */
    stepUpCovers?: boolean | undefined;
  },
): Promise<PublishPlan> {
  const { app, workspaceId, actor } = input;
  const google = supports(app.platform, 'transactionalEdits');
  // ONE EDIT, ONE COMMIT (docs/adr/0069-one-play-commit.md): on Google Play a `push_and_submit` and a `release` named together are ONE
  // step. The release is made in the same edit as the texts, the graphics and the release fields, and committed once. Never two commits
  // that each send for review: Google refuses the second (`changes_in_review`) and leaves the first one's changes in review.
  const oneCommit =
    google &&
    (input.steps ?? []).some((s) => s.type === 'push_and_submit') &&
    (input.steps ?? []).some((s) => s.type === 'release');
  const rights = withCombinedRight(input.rights, oneCommit);
  const enabled: Record<PublishStep, boolean> = {
    push_draft: ctx.draft.draftEnabled,
    // Both switches: the push's and the submit's (or, with the release in the same commit, the push's and the release's).
    push_and_submit:
      ctx.draft.draftEnabled && (oneCommit ? ctx.release.releaseEnabled : ctx.submit.submitEnabled),
    submit: ctx.submit.submitEnabled,
    release: ctx.release.releaseEnabled,
    rollout: ctx.rollout.rolloutEnabled,
  };
  // Google Play, release fields only: the default plan is ONE direct release (docs/adr/0029-direct-play-release.md), not a push, a
  // submit and a release. A person who wants only the draft asks for the push alone ("Save as a draft only"): that is explicit.
  const staged = supports(app.platform, 'directRelease')
    ? await stagedForDirect(ctx.db, app)
    : null;
  const directHint =
    staged !== null && staged.track !== null && staged.codes.length > 0
      ? { track: staged.track, versionCodes: staged.codes, stagedFraction: staged.fraction }
      : null;
  const defaultedToDirect =
    input.steps === undefined &&
    staged !== null &&
    directHint !== null &&
    staged.texts === 0 &&
    staged.assets === 0 &&
    staged.fields > 0 &&
    enabled.release &&
    rights.release;
  // Google Play: this app's last run was refused a draft by Google. A person who wants the changes reviewed is offered the push and the
  // submit as one step by default (the pair stays selectable). Never a fallback of a refused push: only a plan the person confirms.
  const draftRefused =
    google &&
    (await draftRefusedBefore(ctx.db, {
      workspaceId,
      appId: app.id,
      platform: app.platform,
    }));
  const changesInReview =
    google &&
    (await changesInReviewBefore(ctx.db, {
      workspaceId,
      appId: app.id,
      platform: app.platform,
    }));
  const defaultedToCombined =
    input.steps === undefined &&
    !defaultedToDirect &&
    draftRefused &&
    enabled.push_and_submit &&
    rights.push_and_submit;
  const askedSteps: readonly StepRequest[] | undefined = defaultedToDirect
    ? [
        {
          type: 'release',
          direct: true,
          track: directHint?.track ?? '',
          versionCodes: directHint?.versionCodes ?? [],
        },
      ]
    : input.steps;
  const explicit = askedSteps !== undefined;
  const requests = new Map<PublishStep, StepRequest>((askedSteps ?? []).map((s) => [s.type, s]));
  const facts = await loadPendingFacts(ctx.db, { workspaceId, appId: app.id, now: ctx.now() });
  const approvedStored = (facts.releases.get(app.id) ?? []).some((r) => r.status === 'approved');
  const dueStored = (facts.steps.get(app.id) ?? []).length > 0;
  const done: Done = {};
  /** What the push promises later steps (set when it is included). */
  let pushPreview: DraftPreview | undefined;

  const evalPush = async (keep = true, startsRelease = false): Promise<Evaluation> => {
    const p = await previewDraftPush(ctx.draft, { workspaceId, appId: app.id, actor });
    if (!p.ok) {
      if (p.body.error === 'nothing_staged')
        return unavailable('nothing_to_do', 'Nothing is staged for this app.');
      return unavailable('blocked', messageOf(p), problemOfFailure(p));
    }
    const pre = p.preview;
    // Starting the release is itself something to do: a store that already holds every text and the draft is still released.
    if (pre.summary.nothingToDo && !startsRelease)
      return unavailable(
        'nothing_to_do',
        "The store's draft already holds everything that is staged.",
        [],
        pre,
      );
    if (pre.checks.blocking.length > 0)
      return unavailable(
        'blocked',
        'The store says some staged release fields cannot be written.',
        problemsFromChecks(pre.checks),
        pre,
      );
    if (keep) pushPreview = pre;
    return {
      availability: 'available',
      reason: null,
      deferred: false,
      summary: {
        textChanged: pre.summary.textChanged,
        assetSetsChanged: pre.summary.assetSetsChanged,
        fieldsChanged: pre.summary.fieldsChanged,
        filesToUpload: pre.summary.filesToUpload,
        filesToRemove: pre.summary.filesToRemove,
        versionString: pre.version?.versionString ?? null,
      },
      preview: pre,
      confirmHash: pre.confirmHash,
      stepPhrase: null,
      problems: problemsFromChecks({ blocking: [], warnings: pre.checks.warnings }),
    };
  };

  const ONLY_RELEASE_FIELDS =
    'Only release fields were written, no listing text or graphic. Google Play has nothing to submit for them: the release step sends them to Google.';

  const COMBINED_ONLY_GOOGLE = 'Only Google Play can push and send for review in one step.';

  /**
   * Google Play: the push and the submit as ONE commit. Previewed with the push's own preview (the same edit, the same confirm hash:
   * what the person saw is what is written, and the store is read again right before). It sends the changes for review, so it needs
   * the push's and the submit's rights and switches and the typed phrase, and it never runs next to the pair it replaces.
   */
  const evalPushAndSubmit = async (request: StepRequest | undefined): Promise<Evaluation> => {
    if (done.push_draft?.included || requests.has('submit')) {
      const message =
        'Push and submit in one step already pushes the changes and sends them for review. Leave out the separate draft push and submit in the same plan.';
      return unavailable('blocked', message, [
        { code: 'combined_with_pair', severity: 'error', message },
      ]);
    }
    const replaces = request?.replaceReview === true;
    const replaceProblem: PlanProblem[] = replaces
      ? [
          {
            code: 'replaces_review',
            severity: 'warning',
            message:
              'This cancels the review that Google Play has in progress and sends everything together, including what was in that review. The app loses its place in the review queue. It cannot be undone from here.',
          },
        ]
      : [];
    if (oneCommit) {
      // The release goes in the same edit: it is made from the STAGED release fields (track, version codes, notes), so they must exist.
      const releaseRequest = requests.get('release');
      const track = releaseRequest?.track ?? staged?.track ?? undefined;
      const codes = releaseRequest?.versionCodes ?? staged?.codes ?? [];
      const message = (text: string, code: string): Evaluation =>
        unavailable('blocked', text, [{ code, severity: 'error', message: text }]);
      if (staged === null || staged.track === null || staged.codes.length === 0)
        return message(
          'The release is made from the staged release fields. Stage the track and the version codes first, or leave the release out of this plan.',
          'one_commit_release_not_staged',
        );
      if (
        track !== staged.track ||
        [...codes].map(String).sort().join(',') !== [...staged.codes].sort().join(',')
      )
        return message(
          'This release names a track or version codes that are not the staged ones. In one commit, the release is made from the staged release fields: stage the ones you mean, or release them on their own.',
          'one_commit_release_mismatch',
        );
      const asked = requestOfInput(app, {
        track,
        versionCodes: [...codes],
        userFraction: releaseRequest?.userFraction,
      });
      if (!asked.ok) {
        const code = asked.body.error;
        const text = messageOf(asked);
        return unavailable(
          code === 'track_required' || code === 'user_fraction_required'
            ? 'needs_input'
            : 'blocked',
          text,
          [{ code, severity: 'error', message: text }],
        );
      }
      const base = await evalPush(false, true);
      if (base.availability !== 'available') return base;
      const fraction = asked.request.userFraction ?? 1;
      return {
        ...base,
        summary: {
          ...(base.summary ?? {}),
          sendsForReview: true,
          oneCommit: true,
          release: {
            track,
            versionCodes: [...codes],
            userFraction: fraction,
            audience: fraction === 1 ? 'all' : 'percent',
          },
          ...(replaces ? { replacesReview: true } : {}),
        },
        problems: [
          ...base.problems,
          {
            code: 'one_commit',
            severity: 'warning',
            message:
              'The texts, the graphics and the release go to Google Play in ONE edit and ONE commit, and Google reviews them together. Everything pending for this app in Play Console goes with them.',
          },
          ...replaceProblem,
        ],
      };
    }
    const base = await evalPush(false);
    if (base.availability !== 'available') return base;
    const pre = base.preview as DraftPreview;
    if (pre.summary.textChanged + pre.summary.assetSetsChanged === 0)
      return unavailable('nothing_to_do', ONLY_RELEASE_FIELDS, [], pre);
    return {
      ...base,
      summary: {
        ...(base.summary ?? {}),
        sendsForReview: true,
        ...(replaces ? { replacesReview: true } : {}),
      },
      problems: [
        ...base.problems,
        {
          code: 'sends_everything_pending',
          severity: 'warning',
          message:
            'Everything pending for this app in Play Console goes to review with these changes, not only what was pushed here. A draft release stays a draft: no track or rollout is started.',
        },
        ...replaceProblem,
      ],
    };
  };

  const evalSubmit = async (): Promise<Evaluation> => {
    if (done.push_and_submit?.included) {
      const message =
        'The combined step already sends the changes for review. Leave out the separate submit in the same plan.';
      return unavailable('blocked', message, [
        { code: 'combined_with_pair', severity: 'error', message },
      ]);
    }
    if (done.push_draft?.included && pushPreview) {
      // The record of the push does not exist yet (or will change): the submit is previewed after the push applied.
      const after = await recordAfterPush(ctx.db, app, pushPreview);
      if (supports(app.platform, 'releaseTracks') && after.texts + after.assetSets === 0)
        return unavailable('nothing_to_do', ONLY_RELEASE_FIELDS);
      return {
        availability: 'available',
        reason: null,
        deferred: true,
        summary: {
          versionString: after.versionString,
          texts: after.texts,
          assetSets: after.assetSets,
        },
        preview: null,
        confirmHash: null,
        stepPhrase: confirmationPhrase(app, { versionString: after.versionString }),
        problems: [
          {
            code: 'previewed_after_push',
            severity: 'warning',
            message:
              'The submit is previewed again after the draft was pushed, and runs only if it matches this summary.',
          },
        ],
      };
    }
    if (supports(app.platform, 'releaseTracks')) {
      const record = await loadPush(ctx.db, app.id, app.platform);
      if (record && record.manifest.text.length + record.manifest.assets.length === 0)
        return unavailable('nothing_to_do', ONLY_RELEASE_FIELDS);
    }
    const p = await previewSubmit(ctx.submit, { workspaceId, appId: app.id, actor });
    if (!p.ok) {
      if (p.body.error === 'nothing_pushed')
        return unavailable(
          'nothing_to_do',
          'No draft push is recorded, so there is nothing to submit.',
        );
      return unavailable('blocked', messageOf(p), problemOfFailure(p));
    }
    const pre = p.preview;
    if (!pre.checks.canSubmit)
      return unavailable(
        'blocked',
        'Something stands in the way of submitting.',
        problemsFromChecks(pre.checks),
        pre,
      );
    return {
      availability: 'available',
      reason: null,
      deferred: false,
      summary: {
        versionString: pre.version?.versionString ?? null,
        texts: pre.contents.pushed.texts,
        assetSets: pre.contents.pushed.assetSets,
      },
      preview: pre,
      confirmHash: pre.confirmHash,
      stepPhrase: pre.confirmation?.phrase ?? null,
      problems: problemsFromChecks({ blocking: [], warnings: pre.checks.warnings }),
    };
  };

  const evalRelease = async (request: StepRequest | undefined): Promise<Evaluation> => {
    if (oneCommit) {
      // Made by the combined step, in ITS edit and ITS commit: this step is the release as the person ticked it, and it runs nothing of its own.
      const carrier = done.push_and_submit;
      if (carrier === undefined || !carrier.included)
        return unavailable(
          carrier?.availability === 'needs_input' ? 'needs_input' : 'blocked',
          carrier?.reason ??
            'The release is made together with the push and the send for review, and that step cannot run.',
          carrier?.problems ?? [],
        );
      const made = (carrier.summary ?? {}).release as
        | { track: string; versionCodes: string[]; userFraction: number; audience: string }
        | undefined;
      return {
        availability: 'available',
        reason: null,
        deferred: false,
        summary: {
          track: made?.track ?? null,
          userFraction: made?.userFraction ?? null,
          audience: made?.audience ?? 'all',
          direct: true,
          creates: true,
          versionCodes: made?.versionCodes ?? [],
          notesLanguages: [],
          sameCommit: true,
        },
        preview: null,
        confirmHash: null,
        stepPhrase: null,
        problems: [],
      };
    }
    if (google && done.submit?.included) {
      // Two commits that each send for review: Google refuses the second while the first one's changes are in review.
      const message =
        'On Google Play the release already sends everything pending to Google for review. A separate submit before it would put changes in review first, and Google refuses the release while changes are in review. Leave out the submit, or release the staged build together with the push and the send for review in one step.';
      return unavailable('blocked', message, [
        { code: 'two_review_commits', severity: 'error', message },
      ]);
    }
    const what: ReleaseInput = {
      version: request?.version,
      track: request?.track,
      versionCodes: request?.versionCodes,
      userFraction: request?.userFraction,
      direct: request?.direct,
    };
    const resolved = await resolveDirect(ctx.db, app, what);
    if (!resolved.ok)
      return unavailable('blocked', messageOf(resolved), problemOfFailure(resolved));
    const asked = requestOfInput(app, resolved.input);
    if (request?.direct === true && (done.push_draft?.included || done.push_and_submit?.included)) {
      const message =
        'A direct release makes the release from the staged fields itself. Leave out the draft push in the same plan, or untick the direct release.';
      return unavailable('blocked', message, [
        { code: 'direct_with_push', severity: 'error', message },
      ]);
    }
    if (!asked.ok) {
      const code = asked.body.error;
      const message = messageOf(asked);
      // A release that names no track or share is not an error: it only needs input from the person.
      return unavailable(
        code === 'track_required' || code === 'user_fraction_required' ? 'needs_input' : 'blocked',
        message,
        [{ code, severity: 'error', message }],
      );
    }
    if (!explicit && supports(app.platform, 'approvalHold') && !approvedStored)
      return unavailable(
        'nothing_to_do',
        'No approved version is waiting for release (as of the last store sync).',
      );
    const p = await previewRelease(ctx.release, { workspaceId, appId: app.id, actor, ...what });
    if (!p.ok) return unavailable('blocked', messageOf(p), problemOfFailure(p));
    const pre = p.preview;
    // Only a Google Play draft release is rewritten by a push; an App Store release acts on the approved version, not the editable one.
    const afterPush =
      (done.push_draft?.included === true || done.push_and_submit?.included === true) &&
      supports(app.platform, 'releaseTracks');
    const blockingCodes = pre.checks.blocking.map((c) => c.code);
    if (!pre.checks.canRelease) {
      const tolerated = afterPush && blockingCodes.every((c) => RELEASE_DEFERRABLE.includes(c));
      if (!tolerated) {
        const nothing =
          blockingCodes.length > 0 &&
          blockingCodes.every((c) => c === 'not_releasable' || c === 'no_draft_release');
        if (nothing && request !== undefined && request.direct !== true && staged?.track) {
          // The person asked for this release and a build is staged, but there is no draft to start: never a silent "nothing to do".
          // The way forward is the direct release (the staged build, made and sent in one step), or the draft first.
          const message = `The ${asked.request.track ?? staged.track} track has no draft release to start. Release the staged build in one step instead (it is sent to Google for review), or push the draft first.`;
          return unavailable('blocked', message, [
            { code: 'no_draft_release', severity: 'error', message },
          ]);
        }
        return unavailable(
          nothing ? 'nothing_to_do' : 'blocked',
          nothing
            ? 'Nothing is waiting to be released.'
            : 'Something stands in the way of releasing.',
          problemsFromChecks(pre.checks),
          pre,
        );
      }
      return {
        availability: 'available',
        reason: null,
        deferred: true,
        summary: {
          track: asked.request.track ?? null,
          userFraction: asked.request.userFraction ?? null,
          audience: pre.audience.kind,
        },
        preview: pre,
        confirmHash: null,
        stepPhrase: confirmationPhraseOf(app, asked.request, undefined),
        problems: [
          ...problemsFromChecks({ blocking: [], warnings: pre.checks.warnings }),
          {
            code: 'previewed_after_push',
            severity: 'warning',
            message:
              'The draft release does not exist yet: this step is previewed again after the draft was pushed, and runs only if it matches this summary.',
          },
        ],
      };
    }
    return {
      availability: 'available',
      reason: null,
      deferred: afterPush,
      summary: releaseSummary(app, pre, asked.request.userFraction),
      preview: pre,
      confirmHash: afterPush ? null : pre.confirmHash,
      stepPhrase: pre.confirmation?.phrase ?? null,
      problems: [
        ...problemsFromChecks({ blocking: [], warnings: pre.checks.warnings }),
        ...(afterPush
          ? [
              {
                code: 'previewed_after_push',
                severity: 'warning' as const,
                message:
                  'This release is previewed again after the draft was pushed, and runs only if it matches this summary.',
              },
            ]
          : []),
      ],
    };
  };

  const evalRollout = async (request: StepRequest | undefined): Promise<Evaluation> => {
    if (request === undefined) {
      return dueStored
        ? unavailable(
            'needs_input',
            'A rollout step of a release plan is due. Name the change to make (action, and the track and version codes or the version).',
          )
        : unavailable('nothing_to_do', 'No rollout change was asked for.');
    }
    if (done.release?.included) {
      return unavailable(
        'blocked',
        'A rollout cannot be changed in the same batch that starts a release: the release changes what the rollout would act on. Publish the release first, then change the rollout.',
        [
          {
            code: 'rollout_after_release',
            severity: 'error',
            message: 'Start the release first, then change its rollout in a second publish.',
          },
        ],
      );
    }
    const rolloutRequest: RolloutRequest = {
      action: request.action ?? '',
      track: request.track,
      versionCodes: request.versionCodes,
      version: request.version,
      userFraction: request.userFraction,
    };
    const p = await previewRollout(ctx.rollout, {
      workspaceId,
      appId: app.id,
      request: rolloutRequest,
      actor,
    });
    if (!p.ok) return unavailable('blocked', messageOf(p), problemOfFailure(p));
    return {
      availability: 'available',
      reason: null,
      deferred: false,
      summary: {
        action: p.preview.action,
        target: p.preview.target,
        irreversibleInStore: p.preview.irreversible,
        description: p.preview.summary,
      },
      preview: p.preview,
      confirmHash: p.preview.confirmHash,
      stepPhrase: null,
      problems: p.preview.warnings.map(
        (message): PlanProblem => ({ code: 'rollout_note', severity: 'warning', message }),
      ),
    };
  };

  const labelOf = (type: PublishStep, request: StepRequest | undefined): string => {
    if (type === 'push_and_submit' && oneCommit)
      return 'Push the texts and graphics and release the staged build in one step, sent to Google for review';
    if (type === 'release' && oneCommit) return 'Release (made in the same commit as the push)';
    if (type !== 'release') return STEP_LABEL[type];
    if (!supports(app.platform, 'releaseTracks')) return 'Release the approved version';
    return request?.direct === true
      ? `Release to ${request.track ?? 'the track'} (sent to Google for review)`
      : 'Roll out the draft release on Google Play';
  };

  const steps: PlanStep[] = [];
  for (const type of PUBLISH_STEPS) {
    const request = requests.get(type);
    const requested = explicit && request !== undefined;
    const combinedStep = type === 'push_and_submit';
    const requires = {
      action:
        combinedStep && !rights.push_draft
          ? COMBINED_ALSO.action
          : combinedStep && oneCommit
            ? STEP_ACTION.release
            : STEP_ACTION[type],
      envName:
        combinedStep && !ctx.draft.draftEnabled
          ? COMBINED_ALSO.envName
          : combinedStep && oneCommit
            ? STEP_ENV.release
            : STEP_ENV[type],
      enabled: enabled[type],
      allowed: rights[type],
    };
    let ev: Evaluation;
    if (combinedStep && !google) {
      ev = requested
        ? unavailable('blocked', COMBINED_ONLY_GOOGLE, [
            { code: 'combined_not_supported', severity: 'error', message: COMBINED_ONLY_GOOGLE },
          ])
        : unavailable('nothing_to_do', COMBINED_ONLY_GOOGLE);
    } else if (defaultedToCombined && (type === 'push_draft' || type === 'submit')) {
      ev = unavailable(
        'not_requested',
        'Replaced by pushing and submitting in one step: Google Play does not keep a draft for this app.',
      );
    } else if (combinedStep && !requested && !defaultedToCombined) {
      ev = unavailable(
        'not_requested',
        'An alternative to the draft push and the submit: Google Play may refuse to keep a draft for this app, and then this pushes and sends the changes for review in one step.',
      );
    } else if (explicit && !requested) ev = unavailable('not_requested', 'Not part of this batch.');
    else if (!requires.enabled)
      ev = unavailable('feature_disabled', `${requires.envName} is off on this server.`);
    else if (!requires.allowed)
      ev = unavailable('forbidden', `Your role, or this token, does not allow ${requires.action}.`);
    else if (type === 'push_draft') ev = await evalPush();
    else if (type === 'push_and_submit') ev = await evalPushAndSubmit(request);
    else if (type === 'submit') ev = await evalSubmit();
    else if (type === 'release') ev = await evalRelease(request);
    else ev = await evalRollout(request);
    const included = ev.availability === 'available';
    const step: PlanStep = {
      type,
      platform: app.platform,
      order: PUBLISH_STEPS.indexOf(type) + 1,
      label: labelOf(type, request),
      requested,
      included,
      availability: ev.availability,
      reason: ev.reason,
      requires,
      irreversible: IRREVERSIBLE[type],
      deferred: ev.deferred,
      summary: ev.summary,
      request: included ? (request ?? { type }) : null,
      preview: ev.preview,
      confirmHash: ev.confirmHash,
      stepPhrase: ev.stepPhrase,
      problems: ev.problems,
    };
    steps.push(step);
    done[type] = step;
  }

  const included = steps.filter((s) => s.included);
  const irreversibleSteps = included.filter((s) => s.irreversible).map((s) => s.type);
  const warnings: string[] = [];
  const promotion =
    directHint === null
      ? null
      : await promotionOf(ctx.db, app, {
          track: directHint.track,
          versionCodes: directHint.versionCodes,
        });
  const evaluated = (type: PublishStep): boolean =>
    done[type] !== undefined && done[type]?.availability !== 'not_requested';
  // A step that only waits for input (the share) is not unavailable: the person gives it.
  const dead = (type: PublishStep): boolean =>
    evaluated(type) && done[type]?.included !== true && done[type]?.availability !== 'needs_input';
  const recommended = recommendationOf({
    google,
    staged:
      staged === null
        ? null
        : { texts: staged.texts, assets: staged.assets, fields: staged.fields },
    direct:
      directHint === null
        ? null
        : { track: directHint.track, versionCodes: directHint.versionCodes },
    from: promotion?.from ?? null,
    draftRefused,
    canOneCommit: enabled.push_draft && enabled.release && rights.push_draft && rights.release,
    changesInReview,
    can: {
      push_draft: enabled.push_draft && rights.push_draft,
      push_and_submit: enabled.push_and_submit && rights.push_and_submit,
      submit: enabled.submit && rights.submit,
      release: enabled.release && rights.release,
      rollout: enabled.rollout && rights.rollout,
    },
    unavailable: {
      push_draft: dead('push_draft'),
      push_and_submit: dead('push_and_submit'),
      // A release the person asked for another way (not direct) says nothing about the direct one.
      release: requests.get('release')?.direct === true && dead('release'),
    },
    included: included.map((s) => s.type),
  });
  const blockedRequested = explicit && steps.some((s) => s.requested && !s.included);
  const confirmable = included.length > 0 && !blockedRequested;
  const irreversibleBatch = needsPhrase(included.map((s) => s.type));
  const confirmationRequired = irreversibleBatch && input.stepUpCovers !== true;
  const phrase = publishPhrase(app, included.length);
  const planHash = confirmable
    ? sha(
        JSON.stringify({
          v: 1,
          workspaceId,
          appId: app.id,
          platform: app.platform,
          steps: included.map((s) => ({
            type: s.type,
            deferred: s.deferred,
            request: s.request,
            summary: s.summary,
            phrase: s.stepPhrase,
            confirmHash: s.deferred ? null : s.confirmHash,
          })),
        }),
      )
    : null;
  const instruction = `Type "${phrase}" to publish ${included.length === 1 ? 'this step' : `these ${included.length} steps`}.${irreversibleSteps.length > 0 ? ' Some of them cannot be undone from here.' : ''}`;
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    steps,
    publishSteps: included.map((s) => s.request as StepRequest),
    included: included.length,
    irreversible: irreversibleBatch,
    irreversibleSteps,
    warnings,
    confirmable,
    planHash,
    confirmationRequired,
    confirmation: confirmable && confirmationRequired ? { phrase, instruction } : null,
    direct: directHint,
    defaultedToDirect,
    oneCommit: oneCommit && done.push_and_submit?.included === true,
    replacesReview:
      done.push_and_submit?.included === true &&
      requests.get('push_and_submit')?.replaceReview === true,
    changesInReview,
    combined: {
      offered:
        google &&
        enabled.push_and_submit &&
        rights.push_and_submit &&
        done.push_and_submit?.availability !== 'nothing_to_do',
      draftRefused,
      defaulted: defaultedToCombined,
    },
    promotion,
    recommended,
    readAt: ctx.now(),
  };
}

/** What a release will do, as the plan promises it and the deferred preview must keep. */
function releaseSummary(
  app: Pick<ManagedApp, 'platform'>,
  pre: {
    direct?: { creates: boolean; versionCodes: string[]; notesLanguages: string[] } | null;
    version: { versionString: string | null } | null;
    track: string | null;
    release: { versionCodes: string[] } | null;
    audience: { kind: string };
  },
  userFraction: number | undefined,
): Record<string, unknown> {
  return !supports(app.platform, 'releaseTracks')
    ? { version: pre.version?.versionString ?? null, audience: pre.audience.kind }
    : {
        track: pre.track,
        userFraction: userFraction ?? null,
        audience: pre.audience.kind,
        ...(pre.direct
          ? {
              direct: true,
              creates: pre.direct.creates,
              versionCodes: pre.direct.versionCodes,
              notesLanguages: pre.direct.notesLanguages,
            }
          : {}),
      };
}

// ---------------------------------------------------------------------------------------------
// Config

export type PublishConfig = {
  enabled: boolean;
  envName: string;
  action: 'store.publish';
  minimumRole: 'admin';
  /** The batch adds no right and no switch: every step keeps its own. */
  steps: Record<
    PublishStep,
    { action: string; envName: string; enabled: boolean; irreversible: boolean }
  >;
  phrase: string;
  note: string;
};

export const publishConfig = (
  ctx: Pick<PublishContext, 'publishEnabled' | 'draft' | 'submit' | 'release' | 'rollout'>,
): PublishConfig => ({
  enabled: ctx.publishEnabled,
  envName: PUBLISH_ENV,
  action: PUBLISH_ACTION,
  minimumRole: 'admin',
  steps: {
    push_draft: {
      action: STEP_ACTION.push_draft,
      envName: STEP_ENV.push_draft,
      enabled: ctx.draft.draftEnabled,
      irreversible: false,
    },
    push_and_submit: {
      action: STEP_ACTION.push_and_submit,
      envName: STEP_ENV.push_and_submit,
      enabled: ctx.draft.draftEnabled && ctx.submit.submitEnabled,
      irreversible: true,
    },
    submit: {
      action: STEP_ACTION.submit,
      envName: STEP_ENV.submit,
      enabled: ctx.submit.submitEnabled,
      irreversible: true,
    },
    release: {
      action: STEP_ACTION.release,
      envName: STEP_ENV.release,
      enabled: ctx.release.releaseEnabled,
      irreversible: true,
    },
    rollout: {
      action: STEP_ACTION.rollout,
      envName: STEP_ENV.rollout,
      enabled: ctx.rollout.rolloutEnabled,
      irreversible: true,
    },
  },
  phrase: 'publish <app name> <n> steps',
  note: 'The batch publish runs the same gated steps as the individual routes, in order, with one confirmation. It turns no step on and replaces no right: each step needs its own switch and role right (docs/api/pending.md).',
});

export const publishDisabledFailure = (): Failure =>
  failure(
    409,
    'publish_batch_disabled',
    `Publishing several steps at once is switched off on this server. Set ${PUBLISH_ENV}=true to turn it on (see docs/deployment.md). The individual steps keep their own switches.`,
    { envName: PUBLISH_ENV },
  );

// ---------------------------------------------------------------------------------------------
// Preview

/** `POST .../publish/preview`: the plan. Reads the stores through the steps' own previews; writes nothing. */
export async function previewPublish(
  ctx: PublishContext,
  input: {
    workspaceId: string;
    appId: string;
    steps?: readonly StepRequest[] | undefined;
    rights: PublishRights;
    actor: Actor;
    stepUpCovers?: boolean | undefined;
  },
): Promise<{ ok: true; plan: PublishPlan } | Failure> {
  if (!ctx.publishEnabled) return publishDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  let steps: StepRequest[] | undefined;
  if (input.steps !== undefined) {
    const normalized = normalizeSteps(input.steps);
    if (!normalized.ok) return normalized;
    steps = normalized.steps;
  }
  return {
    ok: true,
    plan: await buildPlan(ctx, {
      workspaceId: input.workspaceId,
      app,
      actor: input.actor,
      steps,
      rights: input.rights,
      stepUpCovers: input.stepUpCovers,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// The claim: one batch in flight per app and platform

type Claim = ClaimKey;

async function takeClaim(
  ctx: PublishContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor; steps: readonly PublishStep[] },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_PUBLISH_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const stepsJson = JSON.stringify(input.steps);
  const insert = () =>
    db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at, steps, current_step, step_at, instance_id, heartbeat_at)
       VALUES (?, ?, ?, 'publish', 'writing', ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [
        claim.appId,
        claim.platform,
        input.workspaceId,
        input.actor.id,
        claim.at,
        stepsJson,
        claim.at,
        PROCESS_ID,
        claim.at,
      ],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT claim_at, step_at, heartbeat_at FROM store_publish_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : publishInProgress(null);
  const startedAt = Number(existing.claim_at);
  // Alive: the heartbeat was renewed within the time to live, so a long batch is never taken over while it works.
  if (isLiveClaim(existing, claim.at, ttl)) return publishInProgress(startedAt);
  // A batch that was last heard from long ago (a process died): its claim is ended and its run kept as interrupted (the person sees it
  // in the failure block), then this batch takes the claim. The claims of its steps and their re-reads decide what is safe.
  await reapDeadClaims(db, {
    now: claim.at,
    ttlMs: ttl,
    workspaceId: input.workspaceId,
    appId: claim.appId,
  });
  return (await insert()) === 1 ? { ok: true, claim } : publishInProgress(startedAt);
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_publish_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );

// ---------------------------------------------------------------------------------------------
// Apply

export type StepResult =
  | { type: PublishStep; status: 'applied'; confirmedByReread: boolean; result: unknown }
  | {
      type: PublishStep;
      status: 'skipped';
      /** `previous_step_not_applied`, `plan_drifted` (the step no longer matches what the plan promised), `blocked`, `preview_failed`. */
      reason: 'previous_step_not_applied' | 'plan_drifted' | 'blocked' | 'preview_failed';
      code?: string;
      message: string;
      /** For `blocked`: the codes of the blocking checks. */
      checks?: string[];
    }
  | {
      type: PublishStep;
      status: 'failed';
      /** The individual error code (`state_changed`, `blocked`, `outcome_unknown`, `write_in_progress`, ...). */
      error: string;
      httpStatus: number;
      /** `refused`: nothing was changed as far as this server knows. `not_applied`: read back, not applied. `unknown`: not known, look at the store. `partial`. */
      outcome: 'refused' | 'not_applied' | 'unknown' | 'partial';
      message: string;
      /** The rest of the individual error body (for example `preview` after `state_changed`). */
      detail?: Record<string, unknown>;
    };

export type PublishResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  planHash: string;
  /** Every included step was applied. */
  completed: boolean;
  applied: number;
  skipped: number;
  failed: number;
  /** The first step that was not applied (the rest were skipped). */
  stoppedAt: PublishStep | null;
  steps: StepResult[];
  /** The stored pending state after the batch (no store is read): where things stand now. */
  pending: { items: number; actionable: number; blocking: number };
  publishedAt: number;
  /**
   * What this run is as the server keeps it (`publish-runs.ts`): per step the code, the HTTP status and the sanitised words of the store.
   * Null when it could not be kept (the answer above is complete without it).
   */
  lastPublish: LastPublish | null;
};

const outcomeOf = (f: Failure): 'refused' | 'not_applied' | 'unknown' | 'partial' => {
  if (f.body.outcome === 'not_applied') return 'not_applied';
  if (f.body.error === 'outcome_unknown') return 'unknown';
  if (f.body.error === 'draft_partial') return 'partial';
  return 'refused';
};

const failedStep = (type: PublishStep, f: Failure): StepResult => {
  const { error, message, ...rest } = f.body;
  return {
    type,
    status: 'failed',
    error,
    httpStatus: f.status,
    outcome: outcomeOf(f),
    message: typeof message === 'string' ? message : error,
    ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
  };
};

const isStoreFacts = (value: unknown): value is StoreFacts =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === 'string';

/**
 * One step result as a run keeps it (`publish-runs.ts`): the status, the error code, the HTTP status, the outcome, the sentence of this
 * server and what the store said, all sanitised. Nothing of `detail` is kept beyond the catalogue code of the sentence and the store's
 * facts (a `preview` after `state_changed` is large and is not a reason).
 */
export function runStepOf(result: StepResult, startedAt: number, finishedAt: number): RunStep {
  const base = { type: result.type, status: result.status, startedAt, finishedAt } as const;
  if (result.status === 'applied') return base;
  if (result.status === 'skipped') {
    return {
      ...base,
      reason: result.reason,
      message: sanitiseStoreText(result.message, '', MESSAGE_MAX),
      ...(result.code !== undefined ? { code: sanitiseStoreText(result.code, '', 80) } : {}),
    };
  }
  const detail = result.detail ?? {};
  const own = codingOf(detail);
  const cause = codingOf((detail.storeCause ?? {}) as { code?: unknown; params?: unknown });
  const coding = 'code' in own ? own : cause;
  const params = 'params' in coding ? cleanParams(coding.params) : undefined;
  return {
    ...base,
    error: result.error,
    httpStatus: result.httpStatus,
    outcome: result.outcome,
    message: sanitiseStoreText(result.message, '', MESSAGE_MAX),
    ...('code' in coding ? { code: coding.code } : {}),
    ...(params ? { params } : {}),
    ...(isStoreFacts(detail.store) ? { store: detail.store } : {}),
  };
}

/** The line a failed step adds to the server log: its code, outcome and HTTP status, and the words of the store (sanitised, 200 characters). */
export function failureLogText(result: StepResult & { status: 'failed' }): string {
  const store = isStoreFacts(result.detail?.store) ? result.detail.store : null;
  const said = store?.details?.find((d) => d.detail !== undefined)?.detail ?? result.message;
  return `(${result.error}, ${result.outcome}, http ${result.httpStatus}${store?.details?.[0]?.code ? `, ${store.details[0].code}` : ''}): ${sanitiseStoreText(said, '', 200)}`;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class StepDeadline extends Error {}

/** What a running step reports about itself: a fixed phase word and a count (`DETAIL_PHASES` in `publishing.ts`). */
type StepProgress = (detail: { phase: string; done?: number; total?: number }) => void;

/** `job`, or a `StepDeadline` rejection after `ms`. The job is not stopped (its own timeouts bound it); the batch just stops waiting. */
async function withStepDeadline<T>(job: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepDeadline('deadline')), ms);
  });
  job.catch(() => undefined);
  try {
    return await Promise.race([job, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one step of an accepted plan. A deferred step is previewed now (after the earlier steps applied) and runs only when what it
 * shows is what the plan promised; the batch supplies the phrase the plan promised for the step, never another one.
 */
async function runStep(
  ctx: PublishContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor; progress?: StepProgress },
  step: PlanStep,
  plan: PublishPlan,
): Promise<StepResult> {
  const { workspaceId, actor, app } = input;
  const onProgress = input.progress ? { onProgress: input.progress } : {};
  const type = step.type;
  const skip = (
    reason: 'plan_drifted' | 'blocked' | 'preview_failed',
    message: string,
    extra: { code?: string; checks?: string[] } = {},
  ): StepResult => ({ type, status: 'skipped', reason, message, ...extra });
  const drifted = () =>
    skip(
      'plan_drifted',
      'This step no longer matches what the plan promised, so nothing was written. Review the new plan and publish again.',
    );
  const reqOf = step.request ?? { type };

  if (type === 'push_draft') {
    const r = await applyDraftPush(ctx.draft, {
      workspaceId,
      appId: app.id,
      confirmHash: step.confirmHash ?? '',
      actor,
      ...onProgress,
    });
    return r.ok
      ? {
          type,
          status: 'applied',
          confirmedByReread: Boolean(
            (r.result as { confirmedByReread?: boolean }).confirmedByReread,
          ),
          result: r.result,
        }
      : failedStep(type, r);
  }

  if (type === 'push_and_submit') {
    // The push and the submit as one commit. Previewed in the plan with the push's own preview, so the hash is that preview's: the
    // service re-reads the store right before the commit and refuses (`state_changed`) when it is not what the person saw.
    // ONE COMMIT: when the plan carries the release in this step, its share goes in the same edit (the release step runs nothing of its own).
    const share = plan.oneCommit
      ? plan.steps.find((s) => s.type === 'release' && s.included)?.request?.userFraction
      : undefined;
    const r = await applyDraftPush(ctx.draft, {
      workspaceId,
      appId: app.id,
      confirmHash: step.confirmHash ?? '',
      actor,
      ...onProgress,
      sendForReview: {
        submitEnabled: ctx.submit.submitEnabled,
        ...(share !== undefined
          ? { release: { userFraction: share, enabled: ctx.release.releaseEnabled } }
          : {}),
        ...(reqOf.replaceReview === true ? { replaceReview: true } : {}),
      },
    });
    return r.ok
      ? {
          type,
          status: 'applied',
          confirmedByReread: Boolean(
            (r.result as { confirmedByReread?: boolean }).confirmedByReread,
          ),
          result: r.result,
        }
      : failedStep(type, r);
  }

  if (type === 'submit') {
    let confirmHash = step.confirmHash ?? '';
    let phrase = step.stepPhrase ?? '';
    if (step.deferred) {
      const p = await previewSubmit(ctx.submit, { workspaceId, appId: app.id, actor });
      if (!p.ok) return skip('preview_failed', messageOf(p), { code: p.body.error });
      const pre = p.preview;
      if (!pre.checks.canSubmit || pre.confirmHash === null || pre.confirmation === null) {
        return skip(
          'blocked',
          'Something stands in the way of submitting now that the draft was pushed, so nothing was submitted.',
          { checks: pre.checks.blocking.map((c) => c.code).slice(0, 20) },
        );
      }
      const promised = step.summary as {
        versionString: string | null;
        texts: number;
        assetSets: number;
      };
      const same =
        (pre.version?.versionString ?? null) === promised.versionString &&
        pre.contents.pushed.texts === promised.texts &&
        pre.contents.pushed.assetSets === promised.assetSets;
      if (!same || pre.confirmation.phrase !== step.stepPhrase) return drifted();
      confirmHash = pre.confirmHash;
      phrase = pre.confirmation.phrase;
    }
    const r = await applySubmit(ctx.submit, {
      workspaceId,
      appId: app.id,
      confirmHash,
      confirmation: phrase,
      actor,
    });
    return r.ok
      ? {
          type,
          status: 'applied',
          confirmedByReread: Boolean(
            (r.result as { confirmedByReread?: boolean }).confirmedByReread,
          ),
          result: r.result,
        }
      : failedStep(type, r);
  }

  if (type === 'release') {
    const what: ReleaseInput = {
      version: reqOf.version,
      track: reqOf.track,
      versionCodes: reqOf.versionCodes,
      userFraction: reqOf.userFraction,
      direct: reqOf.direct,
    };
    let confirmHash = step.confirmHash ?? '';
    let phrase = step.stepPhrase ?? '';
    if (step.deferred) {
      const p = await previewRelease(ctx.release, { workspaceId, appId: app.id, actor, ...what });
      if (!p.ok) return skip('preview_failed', messageOf(p), { code: p.body.error });
      const pre = p.preview;
      if (!pre.checks.canRelease || pre.confirmHash === null || pre.confirmation === null) {
        return skip(
          'blocked',
          'Something stands in the way of releasing now that the draft was pushed, so nothing was released.',
          { checks: pre.checks.blocking.map((c) => c.code).slice(0, 20) },
        );
      }
      if (
        pre.confirmation.phrase !== step.stepPhrase ||
        !sameJson(releaseSummary(app, pre, reqOf.userFraction), step.summary)
      )
        return drifted();
      confirmHash = pre.confirmHash;
      phrase = pre.confirmation.phrase;
    }
    const r = await applyRelease(ctx.release, {
      workspaceId,
      appId: app.id,
      ...what,
      confirmHash,
      confirmation: phrase,
      actor,
    });
    return r.ok
      ? {
          type,
          status: 'applied',
          confirmedByReread: Boolean(
            (r.result as { confirmedByReread?: boolean }).confirmedByReread,
          ),
          result: r.result,
        }
      : failedStep(type, r);
  }

  const request: RolloutRequest = {
    action: reqOf.action ?? '',
    track: reqOf.track,
    versionCodes: reqOf.versionCodes,
    version: reqOf.version,
    userFraction: reqOf.userFraction,
  };
  const r = await applyRollout(ctx.rollout, {
    workspaceId,
    appId: app.id,
    request,
    confirmHash: step.confirmHash ?? '',
    actor,
  });
  return r.ok
    ? {
        type,
        status: 'applied',
        confirmedByReread: Boolean((r.result as { confirmedByReread?: boolean }).confirmedByReread),
        result: r.result,
      }
    : failedStep(type, r);
}

/**
 * `POST .../publish`: checks the rights, the switches and the typed phrase, rebuilds the plan from the same requests and refuses when its
 * hash is not `planHash` (`409 plan_changed`), then runs the steps in order through their own services, stopping at the first one that
 * is not applied. Nothing is retried.
 */
export async function applyPublish(
  ctx: PublishContext,
  input: {
    workspaceId: string;
    appId: string;
    planHash: string;
    phrase?: string | undefined;
    steps: readonly StepRequest[];
    rights: PublishRights;
    actor: Actor;
    stepUpCovers?: boolean | undefined;
  },
): Promise<{ ok: true; result: PublishResult } | Failure> {
  if (!ctx.publishEnabled) return publishDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const normalized = normalizeSteps(input.steps);
  if (!normalized.ok) return normalized;
  const requested = normalized.steps;
  if (requested.length === 0) return invalidSteps('Name at least one step.');
  const types = requested.map((s) => s.type);

  // Each step keeps its own right and its own switch: the batch checks them all before anything else. The combined step needs the
  // rights and the switches of the push and of the submit.
  const oneCommit =
    supports(app.platform, 'transactionalEdits') &&
    types.includes('push_and_submit') &&
    types.includes('release');
  const rights = withCombinedRight(input.rights, oneCommit);
  const actionsOf = (t: PublishStep): string =>
    t === 'push_and_submit'
      ? `${COMBINED_ALSO.action} and ${oneCommit ? STEP_ACTION.release : STEP_ACTION[t]}`
      : STEP_ACTION[t];
  const missing = types.filter((t) => !rights[t]);
  if (missing.length > 0) {
    return failure(
      403,
      'forbidden',
      `This batch includes steps you are not allowed to run: ${missing.map(actionsOf).join(', ')}. Nothing was done.`,
      { missing: missing.map((t) => ({ step: t, action: actionsOf(t) })) },
    );
  }
  const switches: Record<PublishStep, boolean> = {
    push_draft: ctx.draft.draftEnabled,
    push_and_submit:
      ctx.draft.draftEnabled && (oneCommit ? ctx.release.releaseEnabled : ctx.submit.submitEnabled),
    submit: ctx.submit.submitEnabled,
    release: ctx.release.releaseEnabled,
    rollout: ctx.rollout.rolloutEnabled,
  };
  const off = types.filter((t) => !switches[t]);
  const envOf = (t: PublishStep): string =>
    t === 'push_and_submit' && !ctx.draft.draftEnabled
      ? COMBINED_ALSO.envName
      : t === 'push_and_submit' && oneCommit
        ? STEP_ENV.release
        : STEP_ENV[t];
  if (off.length > 0) {
    return failure(
      409,
      'step_disabled',
      `This batch includes steps that are switched off on this server: ${off.map(envOf).join(', ')}. Nothing was done.`,
      { disabled: off.map((t) => ({ step: t, envName: envOf(t) })) },
    );
  }
  // The typed phrase needs no store read, so a wrong one is refused before anything is read.
  const phrase = publishPhrase(app, requested.length);
  if (needsPhrase(types) && input.stepUpCovers !== true && (input.phrase ?? '').trim() !== phrase) {
    return failure(
      422,
      'confirmation_mismatch',
      `The confirmation does not match. Type "${phrase}" exactly. Nothing was published.`,
      { phrase, ...coded('confirm.mismatchPublished', { phrase }) },
    );
  }

  const taken = await takeClaim(ctx, {
    workspaceId: input.workspaceId,
    app,
    actor: input.actor,
    steps: types,
  });
  if (!taken.ok) {
    ctx.log?.(`publish: app ${app.id} refused: another batch is in flight (${taken.status})`);
    return taken;
  }
  const claim = taken.claim;
  const stepTimeoutMs = ctx.stepTimeoutMs ?? DEFAULT_PUBLISH_STEP_TIMEOUT_MS;
  // The heartbeat: a timer that says "this process is alive and works on the claim" every few seconds, also while one step waits for the
  // store, so a step that takes minutes is not mistaken for a process that died (and one that died is seen as dead soon).
  let claimLost = false;
  const beat = setInterval(() => {
    recordHeartbeat(db, claim, ctx.now()).then(
      (written) => {
        if (written === 0 && !claimLost) {
          claimLost = true;
          ctx.log?.(
            `publish: app ${app.id} its claim was ended by somebody else; the batch goes on`,
          );
        }
      },
      () => undefined,
    );
  }, ctx.heartbeatMs ?? DEFAULT_PUBLISH_HEARTBEAT_MS);
  beat.unref?.();
  try {
    const planStarted = ctx.now();
    ctx.log?.(`publish: app ${app.id} building the plan again before it writes`);
    let plan: PublishPlan;
    try {
      // The plan is read again from the store before anything is written: bounded like a step, and nothing was written when it is not.
      plan = await withStepDeadline(
        buildPlan(ctx, {
          workspaceId: input.workspaceId,
          app,
          actor: input.actor,
          steps: requested,
          rights: input.rights,
          stepUpCovers: input.stepUpCovers,
        }),
        stepTimeoutMs,
      );
    } catch (error) {
      if (!(error instanceof StepDeadline)) throw error;
      ctx.log?.(
        `publish: app ${app.id} the plan was not built within ${Math.round(stepTimeoutMs / 1000)}s`,
      );
      return failure(
        504,
        'plan_timeout',
        'The store did not answer in time while the plan was read again, so nothing was published. Try again in a moment.',
        coded('store.noAnswer'),
      );
    }
    ctx.log?.(`publish: app ${app.id} plan built after ${ctx.now() - planStarted}ms`);
    if (!plan.confirmable || plan.planHash === null) {
      return failure(
        409,
        'plan_blocked',
        'Something stands in the way of one of the steps, so nothing was published. Review the new plan.',
        { plan, ...coded('publish.blocked.publish') },
      );
    }
    if (plan.planHash !== input.planHash) {
      return failure(
        409,
        'plan_changed',
        'The plan is not the one that was previewed (the staged changes or the store changed), so nothing was published. Review the new plan and confirm it.',
        { plan, ...coded('publish.planChanged') },
      );
    }

    const log = (line: string) => {
      try {
        ctx.log?.(`publish: ${line}`);
      } catch {
        // A log line never changes what the batch does.
      }
    };
    const included = plan.steps.filter((s) => s.included);
    // Where the batch is, for the screens that ask (`publishing.ts`): which steps run, and later which one runs now. Never a reason to stop.
    const note = async (job: () => Promise<unknown>) => {
      try {
        await job();
      } catch (error) {
        log(`progress not recorded (${error instanceof Error ? error.name : typeof error})`);
      }
    };
    // What the running step says it is doing ("uploading 12 of 40"): written to the claim, at most once in a while per phase.
    let lastDetail = { at: Number.NEGATIVE_INFINITY, phase: '' };
    const progress: StepProgress = (d) => {
      if (!(DETAIL_PHASES as readonly string[]).includes(d.phase)) return;
      const at = ctx.now();
      if (d.phase === lastDetail.phase && at - lastDetail.at < DETAIL_THROTTLE_MS) return;
      lastDetail = { at, phase: d.phase };
      void note(() => recordDetail(db, claim, { ...d, phase: d.phase as DetailPhase }, at));
    };
    await note(() =>
      recordSteps(
        db,
        claim,
        included.map((s) => s.type),
        ctx.now(),
      ),
    );
    const batchStarted = ctx.now();
    log(
      `app ${app.id} (${app.platform}) plan ${plan.planHash.slice(0, 8)} steps ${included.map((s) => s.type).join(',')} started`,
    );
    const results: StepResult[] = [];
    /** When each step started and ended, in step order (a step that did not run has the moment it was skipped). */
    const times: { startedAt: number; finishedAt: number }[] = [];
    let stopped: PublishStep | null = null;
    let position = 0;
    for (const step of included) {
      position += 1;
      if (stopped !== null) {
        log(`step ${position}/${included.length} ${step.type} not run: ${stopped} was not applied`);
        results.push({
          type: step.type,
          status: 'skipped',
          reason: 'previous_step_not_applied',
          message: `Not run: ${stopped} was not applied.`,
        });
        times.push({ startedAt: ctx.now(), finishedAt: ctx.now() });
        continue;
      }
      const stepStarted = ctx.now();
      log(`step ${position}/${included.length} ${step.type} started`);
      await note(() => recordStep(db, claim, step.type, stepStarted));
      let result: StepResult;
      try {
        const carried = plan.oneCommit && step.type === 'release';
        const carrier = results.find((r) => r.type === 'push_and_submit');
        result =
          carried && carrier?.status === 'applied'
            ? // Made by the push_and_submit step, in its edit and its one commit: nothing more to run, nothing to send.
              {
                type: 'release',
                status: 'applied',
                confirmedByReread: carrier.confirmedByReread,
                result: { madeBy: 'push_and_submit', sameCommit: true },
              }
            : await withStepDeadline(
                runStep(
                  ctx,
                  { workspaceId: input.workspaceId, app, actor: input.actor, progress },
                  step,
                  plan,
                ),
                stepTimeoutMs,
              );
      } catch (error) {
        const late = error instanceof StepDeadline;
        // Not knowing is not "no": never retried, and the person is told to look.
        log(
          `step ${position}/${included.length} ${step.type} ${late ? `did not finish within ${Math.round(stepTimeoutMs / 1000)}s` : `threw ${error instanceof Error ? error.name : typeof error}`}`,
        );
        result = {
          type: step.type,
          status: 'failed',
          error: late ? 'step_timeout' : 'step_error',
          httpStatus: late ? 504 : 502,
          outcome: 'unknown',
          message: late
            ? `The step did not finish within ${Math.round(stepTimeoutMs / 60_000)} minutes, so it is not known whether it reached the store. Look at the app in the store, then preview again.`
            : 'The step stopped unexpectedly, so it is not known whether it reached the store. Look at the app in the store, then preview again.',
          ...coded('publish.stepStopped'),
        };
      }
      results.push(result);
      times.push({ startedAt: stepStarted, finishedAt: ctx.now() });
      await note(() => recordStep(db, claim, null, ctx.now(), result.status === 'applied'));
      log(
        `step ${position}/${included.length} ${step.type} ${result.status}${result.status === 'failed' ? ` ${failureLogText(result)}` : result.status === 'skipped' ? ` (${result.reason})` : ''} after ${ctx.now() - stepStarted}ms`,
      );
      if (result.status !== 'applied') stopped = step.type;
    }
    log(
      `app ${app.id} finished after ${ctx.now() - batchStarted}ms, stopped at ${stopped ?? 'nothing'}`,
    );

    const at = ctx.now();
    const count = (s: StepResult['status']) => results.filter((r) => r.status === s).length;
    const applied = count('applied');
    const failedCount = count('failed');
    const skipped = count('skipped');
    const completed = applied === results.length;
    const store = storeFor(app.platform);
    // Ids, counts, hashes and per-step outcomes: never a text, a credential or a store answer.
    const kept = results.map((r, i) =>
      runStepOf(r, times[i]?.startedAt ?? batchStarted, times[i]?.finishedAt ?? at),
    );
    const stepsOut = results.map((r, i) => ({
      type: r.type,
      status: r.status,
      ...(r.status === 'failed'
        ? {
            code: r.error,
            outcome: r.outcome,
            httpStatus: r.httpStatus,
            ...(kept[i]?.code !== undefined ? { cause: kept[i]?.code } : {}),
          }
        : {}),
      ...(r.status === 'skipped' ? { reason: r.reason, ...(r.code ? { code: r.code } : {}) } : {}),
      ...(r.status === 'applied' ? { confirmedByReread: r.confirmedByReread } : {}),
    }));
    if (applied + failedCount > 0) {
      await db.transaction(async (tx) => {
        await recordAudit(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          action: 'pending.published',
          target: { type: 'app', id: app.id },
          detail: {
            appId: app.id,
            store,
            platform: app.platform,
            hash: plan.planHash,
            outcome: completed ? 'completed' : applied > 0 ? 'partial' : 'failed',
            applied,
            skipped,
            failed: failedCount,
            steps: stepsOut,
          },
          at,
        });
        if (applied > 0) {
          await emitEvent(tx, {
            workspaceId: input.workspaceId,
            type: 'pending.published',
            subject: { appId: app.id },
            payload: {
              appId: app.id,
              store,
              platform: app.platform,
              planHash: plan.planHash,
              completed,
              applied,
              skipped,
              failed: failedCount,
              steps: stepsOut,
            },
            at,
          });
        }
      });
    }
    const outcome: RunOutcome = completed ? 'completed' : applied > 0 ? 'partial' : 'failed';
    // The run is kept for the screens that come later (a reload, another browser). A failure to keep it never changes the answer.
    let lastPublish: LastPublish | null = null;
    try {
      lastPublish = await recordRun(db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        platform: app.platform,
        startedAt: batchStarted,
        finishedAt: at,
        outcome,
        steps: included.map((s) => s.type),
        results: kept,
        byUser: input.actor.type === 'user' ? input.actor.id : null,
      });
    } catch (error) {
      log(`run not kept (${error instanceof Error ? error.name : typeof error})`);
    }
    const items: PendingItem[] = await pendingItemsOf(db, {
      workspaceId: input.workspaceId,
      app,
      now: at,
    });
    const totals = totalsOf(items);
    return {
      ok: true,
      result: {
        app: plan.app,
        planHash: plan.planHash,
        completed,
        applied,
        skipped,
        failed: failedCount,
        stoppedAt: stopped,
        steps: results,
        pending: { items: totals.items, actionable: totals.actionable, blocking: totals.blocking },
        publishedAt: at,
        lastPublish,
      },
    };
  } finally {
    clearInterval(beat);
    await releaseClaim(db, claim);
  }
}
