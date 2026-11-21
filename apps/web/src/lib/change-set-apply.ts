/**
 * Applying an approved change set (docs/adr/0005-local-clone-reads.md): the two ways, what each
 * needs, and how the result of a commit in the local clone is told. Pure functions: the screens
 * (ChangeSetReview.svelte) only draw what they return. The server decides; this file only keeps the
 * screen from offering what the server will refuse, and says why in words.
 */
import { can, type Role } from '@kiln/core';
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
  return ctx.localOnly
    ? unavailable(
        'This repository has no GitHub connection, so there is no pull request to open. Commit to a branch of the local clone instead.',
      )
    : ok;
}

/** Why a commit in the local clone is not possible right now, or ok. */
export function localBranchAvailability(
  ctx: Pick<ApplyContext, 'hasLocalClone' | 'write'>,
): Availability {
  if (!ctx.hasLocalClone) {
    return unavailable(
      'No local clone is attached to this repository. Attach a folder in the Local clone card first.',
    );
  }
  if (ctx.write === null) {
    return unavailable(
      'Could not read the server setting for writing to local clones. Reload the page and try again.',
    );
  }
  if (!ctx.write.enabled) {
    return unavailable(
      ctx.write.message ??
        `Writing to local clones is not enabled. Set ${ctx.write.envName || WRITE_ENV_NAME}=true on the server and restart it.`,
    );
  }
  return ok;
}

/** Whether the branch can be pushed to GitHub: only a repository with a GitHub connection can. */
export function pushAvailability(ctx: ApplyContext): Availability {
  const local = localBranchAvailability(ctx);
  if (!local.available) return local;
  if (ctx.localOnly)
    return unavailable(
      'This repository has no GitHub connection, so there is nowhere to push the branch.',
    );
  return ok;
}

/** The pull request goes with a push: it needs the push, and so the push's conditions. */
export function openPrAvailability(ctx: ApplyContext, pushChosen: boolean): Availability {
  const push = pushAvailability(ctx);
  if (!push.available) return push;
  if (!pushChosen)
    return unavailable(
      'A pull request needs the branch on GitHub. Tick "Push the branch to GitHub" first.',
    );
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
  if (!available.available) return available.reason ?? 'This cannot be applied.';
  if (choice.mode === 'local_branch') return branchNameProblem(choice.branch);
  return null;
}

// ---------------------------------------------------------------------------------------------
// The branch name

/**
 * The name the server gives the branch when none is typed: `mrm/` + a slug of the summary + the
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
  return `mrm/${slug || 'update'}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Why a typed branch name will be refused, or null. A blank name is fine (the default is used).
 * The same rules as the server, which is the one that decides: ASCII letters, digits and `._-/`,
 * starting with a letter or digit, no `..`, `//`, `@{`, `/.`, no `.lock`, at most 200 characters.
 */
export function branchNameProblem(name: string): string | null {
  const value = name.trim();
  if (value === '') return null;
  if (value !== name) return 'The branch name must not start or end with a space.';
  if (value.length > 200) return 'The branch name is longer than 200 characters.';
  if (value.startsWith('-')) return 'The branch name must not start with "-".';
  if (value === 'HEAD' || value === '@' || value.startsWith('refs/')) {
    return 'That branch name is reserved. Pick a name such as mrm/update-listing.';
  }
  if (value.includes('..')) return 'The branch name must not contain "..".';
  if (value.includes('@{')) return 'The branch name must not contain "@{".';
  if (value.split('/').some((part) => part.endsWith('.lock')))
    return 'A part of the branch name must not end in ".lock".';
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('//') ||
    value.includes('/.') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    return 'Use letters, digits and . _ - / only, starting with a letter or digit, without "//", "/." or a trailing "/" or ".".';
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
  const commit: OutcomeStep = {
    id: 'commit',
    label: 'Commit',
    status: `Committed to ${outcome.commit.branch}`,
    tone: 'ok',
  };
  const push: OutcomeStep =
    outcome.push.status === 'pushed'
      ? { id: 'push', label: 'Push', status: 'Pushed to GitHub', tone: 'ok' }
      : outcome.push.status === 'behind'
        ? {
            id: 'push',
            label: 'Push',
            status: 'The latest fix up is not on GitHub yet',
            tone: 'warn',
          }
        : outcome.push.status === 'failed'
          ? {
              id: 'push',
              label: 'Push',
              status: 'Push failed',
              tone: 'bad',
              ...(outcome.push.error ? { detail: outcome.push.error } : {}),
            }
          : { id: 'push', label: 'Push', status: 'Not pushed', tone: 'neutral' };
  const pr: OutcomeStep =
    outcome.pr.status === 'opened'
      ? { id: 'pr', label: 'Pull request', status: 'Pull request opened', tone: 'ok' }
      : outcome.pr.status === 'failed'
        ? {
            id: 'pr',
            label: 'Pull request',
            status: 'Pull request failed',
            tone: 'bad',
            ...(outcome.pr.error ? { detail: outcome.pr.error } : {}),
          }
        : outcome.pr.status === 'skipped'
          ? {
              id: 'pr',
              label: 'Pull request',
              status: 'Pull request waiting for the push',
              tone: 'warn',
            }
          : { id: 'pr', label: 'Pull request', status: 'No pull request', tone: 'neutral' };
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
        label: failed ? 'Retry the push' : behind ? 'Push the new commit' : 'Push the branch',
        openPr: false,
      },
      {
        id: 'push_pr',
        label: failed ? 'Retry the push and open a pull request' : 'Push and open a pull request',
        openPr: true,
      },
    ];
  }
  if (!prOpen) {
    return [
      {
        id: 'pr',
        label: outcome.pr.status === 'failed' ? 'Retry the pull request' : 'Open a pull request',
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
  if (alreadyApplied) return 'This change set was already applied.';
  const outcome = changeSet.outcome;
  if (!outcome) return 'Pull request opened.';
  if (outcome.push.status === 'failed')
    return `Committed to ${outcome.commit.branch}, but the push failed. The commit is kept; you can retry the push.`;
  if (outcome.pr.status === 'failed')
    return `Committed and pushed ${outcome.commit.branch}, but the pull request was not opened. You can retry it.`;
  if (outcome.pr.status === 'opened') return 'Committed, pushed and opened a pull request.';
  if (outcome.push.status === 'pushed') return `Committed and pushed ${outcome.commit.branch}.`;
  return `Committed to ${outcome.commit.branch} in the local clone.`;
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
      text: `The commit will be signed${signing.format ? ` (${signing.format})` : ''}.`,
    };
  }
  return { signed: false, text: `Commits are not signed (set ${SIGN_ENV_NAME} to enable).` };
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
  const key =
    signature.format === 'gpg'
      ? 'public GPG key'
      : 'public SSH key (as a signing key, not only an authentication key)';
  return {
    label: `Signed (${signature.format})`,
    tip: `GitHub shows "Verified" on this commit only if the ${key} is added to your GitHub account, and the commit's email is a verified email of that account. The signature is not checked here.`,
  };
}

/** What a failed or skipped step of the last apply means for the retry buttons, for a screen reader. */
export const outcomeHasProblem = (outcome: LocalOutcome | null): boolean =>
  outcome !== null && (outcome.push.status === 'failed' || outcome.pr.status === 'failed');

/** Words for Apply when the change set is only applicable as a local commit. */
export const APPLY_LOCAL_EXPLANATION =
  'This writes one commit to a new branch of the local clone on the server. Your checked out branch, the working folder and the index are not touched, so nothing you have open changes. Hooks do not run. Look at it later with git switch.';

/**
 * The note on a local-only repository (the Local clone card, the connect dialog): what applying a
 * change set does there, and, when the server has writing off, how to turn it on.
 */
export function localOnlyNotice(write: WriteConfig): { title: string; text: string } {
  const base =
    'This repository is only a folder on the server, so there is no pull request to open. Applying an approved change set commits the files to a new branch of the folder; you merge that branch yourself.';
  if (write?.enabled)
    return { title: 'Local-only: changes are committed to a new branch', text: base };
  const env = write?.envName || WRITE_ENV_NAME;
  return {
    title: 'Local-only: committing to a branch is off',
    text: `${base} Writing to local clones is not enabled: set ${env}=true on the server and restart it.`,
  };
}
