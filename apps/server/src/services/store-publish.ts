import { createHash } from 'node:crypto';
import { type Platform, supports, versionCodesOf } from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { storeFor } from '../modules/reviews/sync.ts';
import { getApp, type ManagedApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { emitEvent } from './events.ts';
import {
  loadPendingFacts,
  type PendingItem,
  PUBLISH_STEPS,
  type PublishStep,
  pendingItemsOf,
  totalsOf,
} from './pending.ts';
import { type Failure, failure } from './repositories.ts';
import {
  applyDraftPush,
  DRAFT_ENV,
  type DraftContext,
  type DraftPreview,
  previewDraftPush,
} from './store-draft.ts';
import { loadPush } from './store-draft-record.ts';
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

export const PUBLISH_ENV = 'MRM_STORE_PUBLISH_BATCH_ENABLED';
export const PUBLISH_ACTION = 'store.publish';
/** A batch of up to four steps, each with its own timeout (a draft push alone may take four minutes). */
export const DEFAULT_PUBLISH_CLAIM_TTL_MS = 900_000;

export const STEP_ACTION = {
  push_draft: 'store.push_draft',
  submit: 'store.submit',
  release: 'store.release',
  rollout: 'releases.rollout',
} as const;
export const STEP_ENV = {
  push_draft: DRAFT_ENV,
  submit: SUBMIT_ENV,
  release: RELEASE_ENV,
  rollout: ROLLOUT_ENV,
} as const;
const STEP_LABEL = {
  push_draft: 'Push the staged changes to the store as a draft',
  submit: 'Submit the draft for store review',
  release: 'Release',
  rollout: 'Change the rollout',
} as const;
/** Steps that cannot be taken back, or change what live users receive: they need the typed phrase. */
const IRREVERSIBLE: Record<PublishStep, boolean> = {
  push_draft: false,
  submit: true,
  release: true,
  rollout: true,
};

export type PublishContext = {
  db: Database;
  now: () => number;
  /** MRM_STORE_PUBLISH_BATCH_ENABLED. Turns no step on: each step's own switch decides. */
  publishEnabled: boolean;
  draft: DraftContext;
  submit: SubmitContext;
  release: ReleaseContext;
  rollout: RolloutContext;
  claimTtlMs?: number;
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
};

const FIELDS: Record<PublishStep, readonly (keyof StepRequest)[]> = {
  push_draft: [],
  submit: [],
  release: ['version', 'track', 'versionCodes', 'userFraction', 'direct'],
  rollout: ['action', 'version', 'track', 'versionCodes', 'userFraction'],
};

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
  readAt: number;
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
  const enabled: Record<PublishStep, boolean> = {
    push_draft: ctx.draft.draftEnabled,
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
    input.rights.release;
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

  const evalPush = async (): Promise<Evaluation> => {
    const p = await previewDraftPush(ctx.draft, { workspaceId, appId: app.id, actor });
    if (!p.ok) {
      if (p.body.error === 'nothing_staged')
        return unavailable('nothing_to_do', 'Nothing is staged for this app.');
      return unavailable('blocked', messageOf(p), problemOfFailure(p));
    }
    const pre = p.preview;
    if (pre.summary.nothingToDo)
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
    pushPreview = pre;
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

  const evalSubmit = async (): Promise<Evaluation> => {
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
    if (request?.direct === true && done.push_draft?.included) {
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
    const afterPush = done.push_draft?.included === true && supports(app.platform, 'releaseTracks');
    const blockingCodes = pre.checks.blocking.map((c) => c.code);
    if (!pre.checks.canRelease) {
      const tolerated = afterPush && blockingCodes.every((c) => RELEASE_DEFERRABLE.includes(c));
      if (!tolerated) {
        const nothing =
          blockingCodes.length > 0 &&
          blockingCodes.every((c) => c === 'not_releasable' || c === 'no_draft_release');
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

  const steps: PlanStep[] = [];
  for (const type of PUBLISH_STEPS) {
    const request = requests.get(type);
    const requested = explicit && request !== undefined;
    const requires = {
      action: STEP_ACTION[type],
      envName: STEP_ENV[type],
      enabled: enabled[type],
      allowed: input.rights[type],
    };
    let ev: Evaluation;
    if (explicit && !requested) ev = unavailable('not_requested', 'Not part of this batch.');
    else if (!requires.enabled)
      ev = unavailable('feature_disabled', `${requires.envName} is off on this server.`);
    else if (!requires.allowed)
      ev = unavailable('forbidden', `Your role, or this token, does not allow ${requires.action}.`);
    else if (type === 'push_draft') ev = await evalPush();
    else if (type === 'submit') ev = await evalSubmit();
    else if (type === 'release') ev = await evalRelease(request);
    else ev = await evalRollout(request);
    const included = ev.availability === 'available';
    const step: PlanStep = {
      type,
      platform: app.platform,
      order: PUBLISH_STEPS.indexOf(type) + 1,
      label:
        type === 'release'
          ? supports(app.platform, 'releaseTracks')
            ? request?.direct === true
              ? `Release to ${request.track ?? 'the track'} (sent to Google for review)`
              : 'Roll out the draft release on Google Play'
            : 'Release the approved version'
          : STEP_LABEL[type],
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
  if (supports(app.platform, 'releaseTracks') && done.submit?.included && done.release?.included) {
    warnings.push(
      'Google Play refuses to start a release while changes are in review (changes_in_review). Submitting first sends changes to review, so the release step may be refused; the batch stops there and reports it.',
    );
  }
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

type Claim = { appId: string; platform: Platform; at: number };

async function takeClaim(
  ctx: PublishContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_PUBLISH_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'publish_in_progress',
      'A publish of this app is in progress. Wait for it to finish.',
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, 'publish', 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT claim_at FROM store_publish_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A batch that started long ago and never finished (a process died). The claims of its steps and their re-reads decide what is safe.
  const taken = await db.execute(
    `UPDATE store_publish_claims SET claim_at = ?, claimed_by = ?, workspace_id = ?
      WHERE app_id = ? AND platform = ? AND status = 'writing' AND claim_at = ?`,
    [claim.at, input.actor.id, input.workspaceId, claim.appId, claim.platform, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Runs one step of an accepted plan. A deferred step is previewed now (after the earlier steps applied) and runs only when what it
 * shows is what the plan promised; the batch supplies the phrase the plan promised for the step, never another one.
 */
async function runStep(
  ctx: PublishContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
  step: PlanStep,
): Promise<StepResult> {
  const { workspaceId, actor, app } = input;
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

  // Each step keeps its own right and its own switch: the batch checks them all before anything else.
  const missing = types.filter((t) => !input.rights[t]);
  if (missing.length > 0) {
    return failure(
      403,
      'forbidden',
      `This batch includes steps you are not allowed to run: ${missing.map((t) => STEP_ACTION[t]).join(', ')}. Nothing was done.`,
      { missing: missing.map((t) => ({ step: t, action: STEP_ACTION[t] })) },
    );
  }
  const switches: Record<PublishStep, boolean> = {
    push_draft: ctx.draft.draftEnabled,
    submit: ctx.submit.submitEnabled,
    release: ctx.release.releaseEnabled,
    rollout: ctx.rollout.rolloutEnabled,
  };
  const off = types.filter((t) => !switches[t]);
  if (off.length > 0) {
    return failure(
      409,
      'step_disabled',
      `This batch includes steps that are switched off on this server: ${off.map((t) => STEP_ENV[t]).join(', ')}. Nothing was done.`,
      { disabled: off.map((t) => ({ step: t, envName: STEP_ENV[t] })) },
    );
  }
  // The typed phrase needs no store read, so a wrong one is refused before anything is read.
  const phrase = publishPhrase(app, requested.length);
  if (needsPhrase(types) && input.stepUpCovers !== true && (input.phrase ?? '').trim() !== phrase) {
    return failure(
      422,
      'confirmation_mismatch',
      `The confirmation does not match. Type "${phrase}" exactly. Nothing was published.`,
      { phrase },
    );
  }

  const taken = await takeClaim(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  try {
    const plan = await buildPlan(ctx, {
      workspaceId: input.workspaceId,
      app,
      actor: input.actor,
      steps: requested,
      rights: input.rights,
      stepUpCovers: input.stepUpCovers,
    });
    if (!plan.confirmable || plan.planHash === null) {
      return failure(
        409,
        'plan_blocked',
        'Something stands in the way of one of the steps, so nothing was published. Review the new plan.',
        { plan },
      );
    }
    if (plan.planHash !== input.planHash) {
      return failure(
        409,
        'plan_changed',
        'The plan is not the one that was previewed (the staged changes or the store changed), so nothing was published. Review the new plan and confirm it.',
        { plan },
      );
    }

    const results: StepResult[] = [];
    let stopped: PublishStep | null = null;
    for (const step of plan.steps.filter((s) => s.included)) {
      if (stopped !== null) {
        results.push({
          type: step.type,
          status: 'skipped',
          reason: 'previous_step_not_applied',
          message: `Not run: ${stopped} was not applied.`,
        });
        continue;
      }
      let result: StepResult;
      try {
        result = await runStep(
          ctx,
          { workspaceId: input.workspaceId, app, actor: input.actor },
          step,
        );
      } catch {
        // Not knowing is not "no": never retried, and the person is told to look.
        result = {
          type: step.type,
          status: 'failed',
          error: 'step_error',
          httpStatus: 502,
          outcome: 'unknown',
          message:
            'The step stopped unexpectedly, so it is not known whether it reached the store. Look at the app in the store, then preview again.',
        };
      }
      results.push(result);
      if (result.status !== 'applied') stopped = step.type;
    }

    const at = ctx.now();
    const count = (s: StepResult['status']) => results.filter((r) => r.status === s).length;
    const applied = count('applied');
    const failedCount = count('failed');
    const skipped = count('skipped');
    const completed = applied === results.length;
    const store = storeFor(app.platform);
    // Ids, counts, hashes and per-step outcomes: never a text, a credential or a store answer.
    const stepsOut = results.map((r) => ({
      type: r.type,
      status: r.status,
      ...(r.status === 'failed' ? { code: r.error, outcome: r.outcome } : {}),
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
      },
    };
  } finally {
    await releaseClaim(db, claim);
  }
}
