/**
 * Applying an approved change set (docs/adr/0005-local-clone-reads.md): the two ways, what each
 * needs, and how the result of a commit in the local clone is told. Pure functions: the screens
 * (ChangeSetReview.svelte) only draw what they return. The server decides; this file only keeps the
 * screen from offering what the server will refuse, and says why in words.
 */
import { can, type Role } from '@kiln/core';
import { t } from './i18n/t.ts';
import type { ChangeSetView, LocalOutcome, LocalSigningConfig, LocalWriteConfig } from './types.ts';

export type ApplyMode = 'github_pr' | 'local_branch';

/** What the Local clone settings say about writing (`GET /repositories/local/config`), or null when unknown. */
export type WriteConfig = LocalWriteConfig | null;

export type ApplyContext = {
  /** No GitHub connection: a folder on the server only. */
  localOnly: boolean;
  /** A folder on the server is attached (always true for a local-only repository). */
  hasLocalClone: boolean;
  write: WriteConfig;
  /** What the server says about signing (`GET /repositories/local/config`); null or absent when unknown. */
  signing?: LocalSigningConfig | null;
};

export type Availability = { available: boolean; reason?: string };

export const WRITE_ENV_NAME = 'KILN_LOCAL_REPO_WRITE';
export const SIGN_ENV_NAME = 'KILN_GIT_SIGN';

const unavailable = (reason: string): Availability => ({ available: false, reason });
const ok: Availability = { available: true };

/** Why a pull request cannot be opened by Apply, or ok. A local-only repository has no GitHub. */
export function githubPrAvailability(ctx: Pick<ApplyContext, 'localOnly'>): Availability {
  return ctx.localOnly ? unavailable(t('publish:apply.githubPr.noConnection')) : ok;
}

/** Why a commit in the local clone is not possible right now, or ok. */
export function localBranchAvailability(
  ctx: Pick<ApplyContext, 'hasLocalClone' | 'write'>,
): Availability {
  if (!ctx.hasLocalClone) {
    return unavailable(t('publish:apply.local.noClone'));
  }
  if (ctx.write === null) {
    return unavailable(t('publish:apply.local.settingUnknown'));
  }
  if (!ctx.write.enabled) {
    return unavailable(
      ctx.write.message ??
        t('publish:apply.local.notEnabled', { env: ctx.write.envName || WRITE_ENV_NAME }),
    );
  }
  return ok;
}

/** Whether the branch can be pushed to GitHub: only a repository with a GitHub connection can. */
export function pushAvailability(ctx: ApplyContext): Availability {
  const local = localBranchAvailability(ctx);
  if (!local.available) return local;
  if (ctx.localOnly) return unavailable(t('publish:apply.push.noConnection'));
  return ok;
}

/** The pull request goes with a push: it needs the push, and so the push's conditions. */
export function openPrAvailability(ctx: ApplyContext, pushChosen: boolean): Availability {
  const push = pushAvailability(ctx);
  if (!push.available) return push;
  if (!pushChosen) return unavailable(t('publish:apply.pr.needsPush'));
  return ok;
}

/** The mode to preselect: the pull request where there is a GitHub connection, otherwise the local commit. */
export function defaultApplyMode(ctx: Pick<ApplyContext, 'localOnly'>): ApplyMode {
  return ctx.localOnly ? 'local_branch' : 'github_pr';
}

export type ApplyChoice = { mode: ApplyMode; branch: string; push: boolean; openPr: boolean };

export const initialChoice = (
  ctx: Pick<ApplyContext, 'localOnly'>,
  branch: string,
): ApplyChoice => ({
  mode: defaultApplyMode(ctx),
  branch,
  push: false,
  openPr: false,
});

/** The choice with what cannot apply switched off (a pull request without a push, a push that is not possible). */
export function normalizeChoice(choice: ApplyChoice, ctx: ApplyContext): ApplyChoice {
  if (choice.mode === 'github_pr') return { ...choice, push: false, openPr: false };
  const push = choice.push && pushAvailability(ctx).available;
  return { ...choice, push, openPr: push && choice.openPr };
}

/** Why Apply cannot go ahead with this choice, or null when it can. Shown beside the button. */
export function applyBlocker(choice: ApplyChoice, ctx: ApplyContext): string | null {
  const available =
    choice.mode === 'github_pr' ? githubPrAvailability(ctx) : localBranchAvailability(ctx);
  if (!available.available) return available.reason ?? t('publish:apply.blocker.generic');
  if (choice.mode === 'local_branch') return branchNameProblem(choice.branch);
  return null;
}

// ---------------------------------------------------------------------------------------------
// The branch name

/**
 * The name the server gives the branch when none is typed: `kiln/` + a slug of the summary + the
 * first 8 characters of the change set id. Kept equal to `localBranchNameFor` in the server so the
 * field can show it; the server uses its own when the field is left as it is.
 */
export function defaultBranchName(id: string, summary: string): string {
  const slug = summary
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `kiln/${slug || 'update'}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Why a typed branch name will be refused, or null. A blank name is fine (the default is used).
 * The same rules as the server, which is the one that decides: ASCII letters, digits and `._-/`,
 * starting with a letter or digit, no `..`, `//`, `@{`, `/.`, no `.lock`, at most 200 characters.
 */
export function branchNameProblem(name: string): string | null {
  const value = name.trim();
  if (value === '') return null;
  if (value !== name) return t('publish:apply.branch.spaces');
  if (value.length > 200) return t('publish:apply.branch.tooLong');
  if (value.startsWith('-')) return t('publish:apply.branch.dash');
  if (value === 'HEAD' || value === '@' || value.startsWith('refs/')) {
    return t('publish:apply.branch.reserved');
  }
  if (value.includes('..')) return t('publish:apply.branch.dots');
  if (value.includes('@{')) return t('publish:apply.branch.atBrace');
  if (value.split('/').some((part) => part.endsWith('.lock')))
    return t('publish:apply.branch.lock');
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('//') ||
    value.includes('/.') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    return t('publish:apply.branch.chars');
  }
  return null;
}

/** What to run to look at the commit: the branch is not checked out, so nothing in the folder changed. */
export const switchHint = (branch: string): string => `git switch ${branch}`;

// ---------------------------------------------------------------------------------------------
// The request

export type ApplyBody = { mode: 'local_branch'; branch?: string; push?: boolean; openPr?: boolean };

/**
 * The body of `POST …/apply`. Nothing for a pull request (the unchanged call). For a local commit
 * the branch is sent only when it is not the default, so the server's own default stays in charge.
 */
export function applyBody(choice: ApplyChoice, defaultBranch: string): ApplyBody | undefined {
  if (choice.mode === 'github_pr') return undefined;
  const branch = choice.branch.trim();
  return {
    mode: 'local_branch',
    ...(branch !== '' && branch !== defaultBranch ? { branch } : {}),
    ...(choice.push ? { push: true } : {}),
    ...(choice.push && choice.openPr ? { openPr: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The result

export type StepTone = 'ok' | 'bad' | 'warn' | 'neutral';
export type OutcomeStep = {
  id: 'commit' | 'push' | 'pr';
  label: string;
  status: string;
  tone: StepTone;
  detail?: string;
};

/** The three steps of a commit in the local clone, each with its own status and, when it failed, why. */
export function outcomeSteps(outcome: LocalOutcome): OutcomeStep[] {
  const label = {
    commit: t('publish:apply.step.commit'),
    push: t('publish:apply.step.push'),
    pr: t('publish:apply.step.pr'),
  };
  const commit: OutcomeStep = {
    id: 'commit',
    label: label.commit,
    status: t('publish:apply.step.committed', { branch: outcome.commit.branch }),
    tone: 'ok',
  };
  const push: OutcomeStep =
    outcome.push.status === 'pushed'
      ? { id: 'push', label: label.push, status: t('publish:apply.step.pushed'), tone: 'ok' }
      : outcome.push.status === 'behind'
        ? {
            id: 'push',
            label: label.push,
            status: t('publish:apply.step.behind'),
            tone: 'warn',
          }
        : outcome.push.status === 'failed'
          ? {
              id: 'push',
              label: label.push,
              status: t('publish:apply.step.pushFailed'),
              tone: 'bad',
              ...(outcome.push.error ? { detail: outcome.push.error } : {}),
            }
          : {
              id: 'push',
              label: label.push,
              status: t('publish:apply.step.notPushed'),
              tone: 'neutral',
            };
  const pr: OutcomeStep =
    outcome.pr.status === 'opened'
      ? { id: 'pr', label: label.pr, status: t('publish:apply.step.prOpened'), tone: 'ok' }
      : outcome.pr.status === 'failed'
        ? {
            id: 'pr',
            label: label.pr,
            status: t('publish:apply.step.prFailed'),
            tone: 'bad',
            ...(outcome.pr.error ? { detail: outcome.pr.error } : {}),
          }
        : outcome.pr.status === 'skipped'
          ? {
              id: 'pr',
              label: label.pr,
              status: t('publish:apply.step.prWaiting'),
              tone: 'warn',
            }
          : { id: 'pr', label: label.pr, status: t('publish:apply.step.noPr'), tone: 'neutral' };
  return [commit, push, pr];
}

export type RetryOption = { id: 'push' | 'push_pr' | 'pr'; label: string; openPr: boolean };

/**
 * What can still be done to a commit in the local clone, by someone who may apply: push it (a
 * failed push is retried the same way), push it and open the pull request, or open the pull
 * request of a branch that is on GitHub. Nothing for a local-only repository or when writing is
 * off, and nothing once everything asked for is done.
 */
export function retryOptions(
  changeSet: Pick<ChangeSetView, 'status' | 'outcome'>,
  ctx: ApplyContext,
  role: Role,
): RetryOption[] {
  const outcome = changeSet.outcome;
  if (changeSet.status !== 'applied' || !outcome || !can(role, 'changesets.approve')) return [];
  if (!pushAvailability(ctx).available) return [];
  const prOpen = outcome.pr.status === 'opened';
  if (outcome.push.status !== 'pushed') {
    const failed = outcome.push.status === 'failed';
    const behind = outcome.push.status === 'behind';
    return [
      {
        id: 'push',
        label: failed
          ? t('publish:apply.retry.push')
          : behind
            ? t('publish:apply.retry.pushNew')
            : t('publish:apply.retry.pushBranch'),
        openPr: false,
      },
      {
        id: 'push_pr',
        label: failed ? t('publish:apply.retry.pushPrRetry') : t('publish:apply.retry.pushPr'),
        openPr: true,
      },
    ];
  }
  if (!prOpen) {
    return [
      {
        id: 'pr',
        label:
          outcome.pr.status === 'failed'
            ? t('publish:apply.retry.prRetry')
            : t('publish:apply.retry.pr'),
        openPr: true,
      },
    ];
  }
  return [];
}

/** The sentence for the toast after Apply. */
export function applyDoneMessage(
  changeSet: Pick<ChangeSetView, 'outcome'>,
  alreadyApplied: boolean | undefined,
): string {
  if (alreadyApplied) return t('publish:apply.done.already');
  const outcome = changeSet.outcome;
  if (!outcome) return t('publish:apply.done.prOpened');
  if (outcome.push.status === 'failed')
    return t('publish:apply.done.pushFailed', { branch: outcome.commit.branch });
  if (outcome.pr.status === 'failed')
    return t('publish:apply.done.prFailed', { branch: outcome.commit.branch });
  if (outcome.pr.status === 'opened') return t('publish:apply.done.pushedAndPr');
  if (outcome.push.status === 'pushed')
    return t('publish:apply.done.pushed', { branch: outcome.commit.branch });
  return t('publish:apply.done.local', { branch: outcome.commit.branch });
}

// ---------------------------------------------------------------------------------------------
// Signing

/**
 * The line the Apply dialog shows about signing, or null when the server did not say (an older
 * server). The server decides and signs with its own key; this only tells the person which it is.
 */
export function signingNote(
  signing: LocalSigningConfig | null | undefined,
): { signed: boolean; text: string } | null {
  if (!signing) return null;
  if (signing.enabled) {
    return {
      signed: true,
      text: signing.format
        ? t('publish:apply.signing.signedFormat', { format: signing.format })
        : t('publish:apply.signing.signed'),
    };
  }
  return { signed: false, text: t('publish:apply.signing.notSigned', { env: SIGN_ENV_NAME }) };
}

/**
 * The badge and the tip for a commit that was signed, or null for one that was not. It says
 * "signed": nothing here has checked the signature. GitHub shows "Verified" only when the public
 * key is on the committer's account as a signing key, and the commit's email is one of theirs.
 */
export function outcomeSignature(
  outcome: Pick<LocalOutcome, 'signature'> | null,
): { label: string; tip: string } | null {
  const signature = outcome?.signature;
  if (signature?.status !== 'signed') return null;
  return {
    label: t('publish:apply.signature.label', { format: signature.format }),
    tip:
      signature.format === 'gpg'
        ? t('publish:apply.signature.tipGpg')
        : t('publish:apply.signature.tipSsh'),
  };
}

/** What a failed or skipped step of the last apply means for the retry buttons, for a screen reader. */
export const outcomeHasProblem = (outcome: LocalOutcome | null): boolean =>
  outcome !== null && (outcome.push.status === 'failed' || outcome.pr.status === 'failed');

/** Words for Apply when the change set is only applicable as a local commit. */
export const applyLocalExplanation = (): string => t('publish:apply.localExplanation');

/**
 * The note on a local-only repository (the Local clone card, the connect dialog): what applying a
 * change set does there, and, when the server has writing off, how to turn it on.
 */
export function localOnlyNotice(write: WriteConfig): { title: string; text: string } {
  const base = t('publish:apply.localOnly.base');
  if (write?.enabled) return { title: t('publish:apply.localOnly.titleOn'), text: base };
  const env = write?.envName || WRITE_ENV_NAME;
  return {
    title: t('publish:apply.localOnly.titleOff'),
    text: t('publish:apply.localOnly.off', { base, env }),
  };
}
