import { z } from 'zod';
import {
  changeSetSchema,
  type Draft,
  id,
  listingQuery,
  none,
  object,
  timestamp,
  W,
} from './shared.ts';

const localConfigSchema = z.object({
  enabled: z.boolean(),
  envName: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  roots: z.array(z.string()).optional().describe('Only for people who may attach a folder.'),
  write: z
    .object({ enabled: z.boolean(), envName: z.string(), message: z.string().optional() })
    .describe(
      'Whether a change set may be committed to a new branch of a local clone (KILN_LOCAL_REPO_WRITE).',
    ),
  signing: z
    .object({ enabled: z.boolean(), format: z.enum(['ssh', 'gpg']).optional() })
    .describe(
      "Whether those commits are signed with the server's key (KILN_GIT_SIGN) and how. Never the key or where it is.",
    ),
});

const applyBody = z.object({
  mode: z.enum(['github_pr', 'local_branch']).optional().describe('Default github_pr.'),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'local_branch: the branch to create. Default kiln/<slug of the summary>-<short id>. ASCII letters, digits and . _ - / only; must not exist.',
    ),
  push: z.boolean().optional().describe('local_branch: push the branch to GitHub afterwards.'),
  openPr: z
    .boolean()
    .optional()
    .describe('local_branch: open a pull request after the push (needs push).'),
});

const publishBody = z.object({
  openPr: z.boolean().optional().describe('Also open the pull request.'),
});

const cloneSchema = z.object({
  repositoryId: z.string(),
  name: z
    .string()
    .nullable()
    .describe(
      '`owner/repo` or the local folder name; null when no repository has this id any more.',
    ),
  kind: z.enum(['github', 'local']),
  bytes: z.number().int(),
  sizeIsLowerBound: z.boolean(),
  lastUsedAt: timestamp,
  createdAt: timestamp.nullable(),
  inUse: z.boolean(),
});

const cloneLimitsSchema = z.object({
  maxBytes: z.number().int().describe('0: no limit.'),
  idleDays: z.number().int().describe('0: never.'),
});

const refreshBody = z.object({
  resolutions: z
    .record(z.enum(['mine', 'theirs']))
    .optional()
    .describe(
      "Per conflicting path: `mine` keeps the change set's text (overwriting the repository's), `theirs` drops the change set's change for that file.",
    ),
});

const fileStateSchema = z.enum(['same', 'changed', 'already_applied', 'conflict']);

const refreshFileSchema = z.object({
  path: z.string(),
  state: fileStateSchema,
  outcome: z.enum(['unchanged', 'merged', 'dropped', 'kept_mine', 'kept_theirs', 'conflict']),
  reason: z
    .enum([
      'overlap',
      'added_upstream',
      'edited_upstream',
      'deleted_upstream',
      'invalid_json',
      'too_large',
    ])
    .optional(),
  base: z.string().nullable().optional(),
  ours: z.string().nullable().optional(),
  theirs: z.string().nullable().optional(),
});

const choicesSchema = z.record(z.enum(['mine', 'theirs']));

const fixupBody = z.object({
  resolutions: choicesSchema
    .optional()
    .describe(
      "Per path that conflicts with the REPOSITORY (the 409 `refresh_conflicts` of the first comparison): `mine` keeps the change set's text, `theirs` drops its change and resets the file on the branch to the repository's text.",
    ),
  branchResolutions: choicesSchema
    .optional()
    .describe(
      "Per path that conflicts with the BRANCH (the 409 `fixup_conflicts` of the second comparison): `mine` overwrites the branch's text, `theirs` keeps the branch's.",
    ),
  push: z.boolean().optional().describe('Local commit only: push the new tip (never forced).'),
  openPr: z
    .boolean()
    .optional()
    .describe('Local commit only: open the pull request when there is none (needs push).'),
  dryRun: z.boolean().optional().describe('Work out and report everything, write nothing.'),
  recompute: z
    .boolean()
    .optional()
    .describe(
      'Take the content from the live store listing (a store pull only), as `POST /change-sets/{id}/recompute` does, instead of the stored files. Needs `listing.read`.',
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      'With `recompute`: read the store first (needs `apps.sync`; rate limited like the pull).',
    ),
});

const fixupFileSchema = z.object({
  path: z.string(),
  state: z.enum(['same', 'changed', 'already_applied', 'conflict', 'recomputed', 'removed']),
  outcome: z.enum(['commit', 'unchanged', 'kept_branch', 'kept_mine', 'kept_theirs', 'conflict']),
  leavesSet: z.boolean(),
  stage: z.enum(['repository', 'branch']).optional(),
  reason: z
    .enum([
      'overlap',
      'added_upstream',
      'edited_upstream',
      'deleted_upstream',
      'invalid_json',
      'too_large',
    ])
    .optional(),
  base: z.string().nullable().optional(),
  ours: z.string().nullable().optional(),
  theirs: z.string().nullable().optional(),
});

const fieldDiffSchema = z.object({
  locale: z.string(),
  repoLocale: z.string(),
  field: z.string(),
  change: z.enum(['store_changed', 'unchanged', 'added', 'dropped']),
  reason: z.string().optional(),
});

const recomputeBody = z.object({
  refresh: z
    .boolean()
    .optional()
    .describe('Read the store first (needs `apps.sync`; rate limited like the pull).'),
});

const changeSetAnswer = {
  description: 'The change set.',
  schema: z.object({ changeSet: changeSetSchema }),
};

const connectBody = z.object({
  credentialId: id,
  owner: z.string().trim().describe('A GitHub user or organization name.'),
  repo: z.string().trim().max(100).describe('A GitHub repository name.'),
});

const localPathText = z
  .string()
  .min(1)
  .max(4096)
  .describe(
    'An absolute folder on the server, inside one of the folders KILN_LOCAL_REPO_ROOTS allows. Symbolic links are resolved first.',
  );

const localBranchText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'A local branch whose committed tip is read. Default: the branch the clone has checked out.',
  );

const localCheckBody = z.object({ path: localPathText, branch: localBranchText.optional() });

const localConnectBody = z.object({
  path: localPathText,
  branch: localBranchText.optional(),
  name: z.string().trim().max(100).optional().describe('Default: the folder name.'),
});

const localAttachBody = z.object({
  path: localPathText
    .optional()
    .describe('Omit to keep the attached folder and change only the branch.'),
  branch: localBranchText.optional(),
  allowRemoteMismatch: z
    .boolean()
    .optional()
    .describe('Confirm a clone whose origin is another repository (a fork or mirror).'),
});

const targetBody = z.object({
  name: z.string().max(200),
  appId: z.string().max(400).nullable().optional(),
  appStoreRoot: z.string().max(400).nullable().optional(),
  googlePlayRoot: z.string().max(400).nullable().optional(),
});

const changeSetBody = z.object({
  target: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A saved listing target id, or `auto:<key>`.'),
  roots: z
    .object({
      appStore: z.string().max(400).optional(),
      googlePlay: z.string().max(400).optional(),
    })
    .strict()
    .optional(),
  summary: z.string().trim().min(1).max(200),
  listing: z
    .record(z.unknown())
    .describe(
      'The store listing to write: `{ appStore?: {...}, googlePlay?: {...} }`. See docs/api/repositories.md.',
    ),
});

export const repositoriesOperations: Draft[] = [
  {
    id: 'listRepositories',
    method: 'get',
    path: `${W}/repositories`,
    tags: ['repositories'],
    summary: 'List connected repositories',
    risk: 'read',
    access: { action: 'repositories.read' },
    partial: true,
    responses: {
      '200': { description: 'Repositories.', schema: z.object({ repositories: z.array(object) }) },
    },
  },
  {
    id: 'connectRepository',
    method: 'post',
    path: `${W}/repositories`,
    tags: ['repositories'],
    summary: 'Connect a GitHub repository',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: connectBody,
    partial: true,
    responses: {
      '201': { description: 'The repository.', schema: z.object({ repository: object }) },
    },
  },
  {
    id: 'getLocalCloneConfig',
    method: 'get',
    path: `${W}/repositories/local/config`,
    tags: ['repositories'],
    summary: 'Whether local clones are enabled on this server',
    description:
      'Local clones are off unless KILN_LOCAL_REPO_ROOTS is set. The allowed folders are listed only to people who may attach one. `write` says whether commits to a local clone are allowed (KILN_LOCAL_REPO_WRITE) and `signing` whether they are signed (KILN_GIT_SIGN: `enabled`, and `format` ssh or gpg); the key and its location are never part of the answer.',
    risk: 'read',
    access: { action: 'repositories.read' },
    partial: true,
    responses: {
      '200': { description: 'The setting.', schema: z.object({ local: localConfigSchema }) },
    },
  },
  {
    id: 'checkLocalClone',
    method: 'post',
    path: `${W}/repositories/local/check`,
    tags: ['repositories'],
    summary: 'Check a folder before attaching it',
    description:
      'Reads the folder with hardened, read-only git: real path, branch, tip commit, origin (owner/repo only), number of uncommitted files, and the connected repository it matches. Only the committed branch is ever read, never uncommitted edits.',
    risk: 'read',
    access: { action: 'repositories.write' },
    body: localCheckBody,
    partial: true,
    responses: { '200': { description: 'What was found.', schema: z.object({ check: object }) } },
  },
  {
    id: 'connectLocalRepository',
    method: 'post',
    path: `${W}/repositories/local`,
    tags: ['repositories'],
    summary: 'Connect a local folder as a repository without GitHub',
    description:
      'A local-only repository is read from the folder. A change set for it is applied as a commit on a new branch of the folder (`mode: local_branch`, needs KILN_LOCAL_REPO_WRITE=true); `github_pr` is refused with 409 local_only.',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: localConnectBody,
    partial: true,
    responses: {
      '201': {
        description: 'The repository (owner, repo and credentialId are null).',
        schema: z.object({ repository: object }),
      },
    },
  },
  {
    id: 'attachLocalClone',
    method: 'put',
    path: `${W}/repositories/{id}/local`,
    tags: ['repositories'],
    summary: 'Attach a local clone to a repository, or change its folder or branch',
    description:
      'Scan, listing and change set creation then read the committed branch of the folder. A change set can still be applied as a pull request through GitHub, or (KILN_LOCAL_REPO_WRITE=true) as a commit on a new branch of the folder.',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: localAttachBody,
    partial: true,
    responses: {
      '200': { description: 'The repository.', schema: z.object({ repository: object }) },
    },
  },
  {
    id: 'detachLocalClone',
    method: 'delete',
    path: `${W}/repositories/{id}/local`,
    tags: ['repositories'],
    summary: 'Detach the local clone of a repository',
    description:
      'Reads go back to GitHub. A local-only repository cannot be detached (409 local_only): disconnect it.',
    risk: 'destructive',
    access: { action: 'repositories.write' },
    partial: true,
    responses: {
      '200': { description: 'The repository.', schema: z.object({ repository: object }) },
    },
  },
  {
    id: 'getRepository',
    method: 'get',
    path: `${W}/repositories/{id}`,
    tags: ['repositories'],
    summary: 'A repository and what was detected in it',
    risk: 'read',
    access: { action: 'repositories.read' },
    partial: true,
    responses: { '200': { description: 'The repository and its detection.', schema: object } },
  },
  {
    id: 'disconnectRepository',
    method: 'delete',
    path: `${W}/repositories/{id}`,
    tags: ['repositories'],
    summary: 'Disconnect a repository',
    risk: 'destructive',
    access: { action: 'repositories.write' },
    responses: { '204': none },
  },
  {
    id: 'scanRepository',
    method: 'post',
    path: `${W}/repositories/{id}/scan`,
    tags: ['repositories'],
    summary: 'Scan a repository and store what is detected',
    risk: 'write',
    access: { action: 'repositories.scan' },
    partial: true,
    responses: { '200': { description: 'The repository and its detection.', schema: object } },
  },
  {
    id: 'getRepositoryListing',
    method: 'get',
    path: `${W}/repositories/{id}/listing`,
    tags: ['repositories'],
    summary: 'The store listing found in the repository',
    risk: 'read',
    access: { action: 'repositories.scan' },
    query: listingQuery,
    partial: true,
    responses: { '200': { description: 'The listing and its problems.', schema: object } },
  },
  {
    id: 'listListingTargets',
    method: 'get',
    path: `${W}/repositories/{id}/listing-targets`,
    tags: ['repositories'],
    summary: 'Saved listing targets of a repository',
    risk: 'read',
    access: { action: 'repositories.read' },
    partial: true,
    responses: {
      '200': { description: 'Targets.', schema: z.object({ targets: z.array(object) }) },
    },
  },
  {
    id: 'createListingTarget',
    method: 'post',
    path: `${W}/repositories/{id}/listing-targets`,
    tags: ['repositories'],
    summary: 'Save a listing target',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: targetBody,
    partial: true,
    responses: { '201': { description: 'The target.', schema: z.object({ target: object }) } },
  },
  {
    id: 'updateListingTarget',
    method: 'patch',
    path: `${W}/repositories/{id}/listing-targets/{targetId}`,
    tags: ['repositories'],
    summary: 'Change a listing target',
    risk: 'write',
    access: { action: 'repositories.write' },
    body: targetBody.partial(),
    partial: true,
    responses: { '200': { description: 'The target.', schema: z.object({ target: object }) } },
  },
  {
    id: 'deleteListingTarget',
    method: 'delete',
    path: `${W}/repositories/{id}/listing-targets/{targetId}`,
    tags: ['repositories'],
    summary: 'Delete a listing target',
    risk: 'destructive',
    access: { action: 'repositories.write' },
    responses: { '204': none },
  },
  {
    id: 'createChangeSet',
    method: 'post',
    path: `${W}/repositories/{id}/change-sets`,
    tags: ['change-sets'],
    summary: 'Draft a change set from a listing',
    description:
      'Writes nothing to the repository: a person with approval rights approves it, then it is applied as a pull request.',
    risk: 'write',
    access: { action: 'changesets.write' },
    body: changeSetBody,
    partial: true,
    responses: {
      '201': {
        description: 'The draft, its problems and warnings.',
        schema: z.object({
          changeSet: changeSetSchema,
          problems: z.array(object),
          warnings: z.array(z.string()).optional(),
        }),
      },
    },
  },
  {
    id: 'listChangeSets',
    method: 'get',
    path: `${W}/change-sets`,
    tags: ['change-sets'],
    summary: 'List change sets',
    risk: 'read',
    access: { action: 'repositories.read' },
    query: z.object({ repositoryId: z.string().optional(), status: z.string().optional() }),
    responses: {
      '200': {
        description: 'Change sets.',
        schema: z.object({ changeSets: z.array(changeSetSchema) }),
      },
    },
  },
  {
    id: 'getChangeSet',
    method: 'get',
    path: `${W}/change-sets/{id}`,
    tags: ['change-sets'],
    summary: 'A change set with its file contents',
    risk: 'read',
    access: { action: 'repositories.read' },
    responses: { '200': changeSetAnswer },
  },
  {
    id: 'approveChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/approve`,
    tags: ['change-sets'],
    summary: 'Approve a draft change set',
    risk: 'write',
    access: { action: 'changesets.approve' },
    responses: { '200': changeSetAnswer },
  },
  {
    id: 'applyChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/apply`,
    tags: ['change-sets'],
    summary:
      'Apply an approved change set (a pull request through GitHub, or a commit on a new branch of the local clone)',
    description:
      "No body, or `mode: github_pr`: a branch and a pull request through the GitHub API (409 local_only for a local-only repository). `mode: local_branch`: one commit on a NEW branch of the repository's local clone, built with git plumbing (the working tree, index, HEAD and current branch are not touched); needs KILN_LOCAL_REPO_WRITE=true (409 local_write_disabled), a local clone (409 no_local_checkout) and files that still match the clone's branch (409 base_changed, with `paths`); an existing branch is never moved (409 branch_exists). When the server signs commits (KILN_GIT_SIGN) the commit is signed with its own key and `outcome.signature` says so; if signing fails nothing is committed, the change set stays approved and the answer is 502 (504 when it timed out) `signing_failed` with a fixed `reason` (`timeout`, `locked`, `key`, `program`, `failed`). `push` pushes that branch to the connected GitHub repository and `openPr` (needs `push`) opens the pull request; a failed push or pull request does not undo the commit: the answer is 200 and `changeSet.outcome` says what happened, then `POST /change-sets/{id}/push` retries.",
    risk: 'write',
    access: { action: 'changesets.approve' },
    body: applyBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description: 'The applied change set (`outcome` for a local commit).',
        schema: z.object({ changeSet: changeSetSchema, alreadyApplied: z.boolean().optional() }),
      },
    },
  },
  {
    id: 'pushChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/push`,
    tags: ['change-sets'],
    summary: 'Push the branch of a local commit, and optionally open the pull request',
    description:
      "For a change set applied with `mode: local_branch`. Pushes the commit to `refs/heads/<branch>` of the connected GitHub repository through the managed, hardened push (never the clone's own remote or hooks), and with `openPr` opens a pull request into the branch the commit was made on. Repeating it is safe: finished steps are skipped (`alreadyDone`). 502 with the change set when a step fails; `changeSet.outcome` says which.",
    risk: 'write',
    access: { action: 'changesets.approve' },
    body: publishBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description: 'The change set with its outcome.',
        schema: z.object({ changeSet: changeSetSchema, alreadyDone: z.boolean().optional() }),
      },
    },
  },
  {
    id: 'listClones',
    method: 'get',
    path: `${W}/clones`,
    tags: ['repositories'],
    summary: 'The managed git clones of this workspace: size and last use',
    description:
      "Admin and owner. Only this workspace's clones are listed (the folder and its limits are the server's): per repository the bytes on disk (cached for ten minutes, a lower bound when the walk reached its cap), when it was last used and whether it is in use now. `kind` is `local` for the managed copy of an attached local folder. No server path is part of the answer. A sweep (KILN_CLONE_SWEEP_INTERVAL_MINUTES) removes clones idle for KILN_CLONE_IDLE_DAYS, then the least recently used above KILN_CLONE_MAX_BYTES; a removed clone is fetched again by the next read. `enabled` is false when reads do not use clones (KILN_READS=api).",
    risk: 'read',
    access: { action: 'repositories.write' },
    responses: {
      '200': {
        description: 'The clones.',
        schema: z.object({
          enabled: z.boolean(),
          clones: z.array(cloneSchema),
          totalBytes: z.number().int(),
          limits: cloneLimitsSchema,
        }),
      },
    },
  },
  {
    id: 'getRepositoryClone',
    method: 'get',
    path: `${W}/repositories/{id}/clone`,
    tags: ['repositories'],
    summary: 'The clone of one repository: size and last use',
    description:
      '`clone` is null when there is none on disk. A repository with an attached local folder shows its two copies as one.',
    risk: 'read',
    access: { action: 'repositories.read' },
    responses: {
      '200': {
        description: 'The clone, if any.',
        schema: z.object({
          enabled: z.boolean(),
          clone: cloneSchema.nullable(),
          limits: cloneLimitsSchema,
        }),
      },
    },
  },
  {
    id: 'purgeRepositoryClone',
    method: 'post',
    path: `${W}/repositories/{id}/clone/purge`,
    tags: ['repositories'],
    summary: 'Remove the clone of a repository now (free the space)',
    description:
      'Admin and owner. The clone is a cache: the next read fetches it again. `409 clone_busy` while a read is running. Audited as `clone.purge` with counts.',
    risk: 'destructive',
    access: { action: 'repositories.write' },
    responses: {
      '200': {
        description: 'What was removed.',
        schema: z.object({ removed: z.number().int(), freedBytes: z.number().int() }),
      },
    },
  },
  {
    id: 'refreshChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/refresh`,
    tags: ['change-sets'],
    summary: 'Refresh a stale change set: re-base it onto the repository as it is now',
    description:
      "For a draft, approved or failed change set (a failed one only when no branch was created; once a branch exists the answer is `409 branch_created`, and `POST /change-sets/{id}/fixup` adds one commit to the branch instead). Each file is read again (from the local clone, or GitHub) and compared: unchanged files stay, files whose change is already in the repository leave the set, and files that changed elsewhere are merged line by line (a three-way merge; an Expo JSON file must still parse). Where both sides changed the same place the answer is `409 refresh_conflicts` with, per conflicting file, `base`, `ours` (the change set's text) and `theirs` (the repository's), and NOTHING is changed; send `resolutions` (`mine`: keep our text and overwrite theirs, `theirs`: drop our change) for each conflicting path to settle it. A refresh that changes the text returns the set to `draft` and clears its approval (`approvalCleared`); one that changes nothing leaves it as it is (`unchanged`). `nothingLeft` means no file remains: discard it. Audited as `changeset.refresh` with counts only.",
    risk: 'write',
    access: { action: 'changesets.write' },
    body: refreshBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description: 'The refreshed change set and what happened to each file.',
        schema: z.object({
          changeSet: changeSetSchema,
          files: z.array(refreshFileSchema),
          refreshedFrom: z.string(),
          unchanged: z.boolean(),
          nothingLeft: z.boolean(),
          approvalCleared: z.boolean(),
        }),
      },
    },
  },
  {
    id: 'getChangeSetStaleness',
    method: 'get',
    path: `${W}/change-sets/{id}/staleness`,
    tags: ['change-sets'],
    summary: 'Is the change set still what the repository holds? (read only)',
    description:
      'Reads the files of the change set from the repository now and says, per file, `same`, `changed` (a clean merge is possible), `already_applied` or `conflict`. Writes nothing. Needs the right a scan needs, because it reads with the stored credential.',
    risk: 'read',
    access: { action: 'repositories.scan' },
    partial: true,
    responses: {
      '200': {
        description: 'Whether it is stale, and per file.',
        schema: z.object({
          stale: z.boolean(),
          files: z.array(z.object({ path: z.string(), state: fileStateSchema })),
          readAt: z.string(),
        }),
      },
    },
  },
  {
    id: 'fixupChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/fixup`,
    tags: ['change-sets'],
    summary: 'Fix up the branch of a change set: add ONE commit on top of it',
    description:
      'For a change set that has a branch: `applied` (a pull request through GitHub, or a commit on a new branch of a local clone) or `failed` with the branch GitHub made before the pull request failed. The content is refreshed first (a three-way merge against the repository, then against the branch: the base of that merge is the text this tool last committed, so edits a person made on the branch are merged, not overwritten), the difference is committed as ONE new commit whose parent is the branch tip that was read, and the branch is moved forward to it with a fast-forward only. History is never rewritten and nothing is forced. 409 `refresh_conflicts` (per file against the repository, resolve with `resolutions`) and 409 `fixup_conflicts` (per file against the branch, resolve with `branchResolutions`) change nothing. No difference: 200 with `nothingToFix` and no commit. `dryRun` reports the plan and writes nothing. Refusals that write nothing: 409 `branch_moved` (the branch is not at the tip that was read), 409 `branch_checked_out` (the local branch is checked out, in a worktree or being rebased: moving it would leave that working folder stale), 409 `pr_closed` (the pull request is merged or closed: create a new change set), 409 `branch_missing`, 409 `fixup_in_progress`, 409 `no_branch`. Local mode needs KILN_LOCAL_REPO_WRITE (409 `local_write_disabled`), signs like apply, and with `push` pushes the new tip without force (409 `remote_diverged` when the branch on GitHub has other commits; the local commit is kept). With `recompute` the content comes from the live store listing. Needs `changesets.approve` (and `listing.read` for `recompute`, `apps.sync` for `refresh`). Audited as `changeset.fixup` / `changeset.fixup_failed` with counts only.',
    risk: 'write',
    access: { action: 'changesets.approve' },
    body: fixupBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description: 'What was done.',
        schema: z.object({
          changeSet: changeSetSchema,
          mode: z.enum(['local_branch', 'github_pr']),
          branch: z.string(),
          nothingToFix: z.boolean(),
          files: z.array(fixupFileSchema),
          willCommit: z.array(z.string()),
          refreshedFrom: z.string(),
          tip: z.string(),
          commit: z
            .object({
              sha: z.string(),
              parent: z.string(),
              files: z.number().int(),
              signed: z.boolean(),
            })
            .optional(),
          pullRequest: z.object({
            state: z.enum(['open', 'opened', 'none']),
            number: z.number().int().optional(),
            url: z.string().optional(),
          }),
          dryRun: z.boolean().optional(),
          conflicts: z.number().int().optional(),
          recompute: object.optional(),
        }),
      },
    },
  },
  {
    id: 'recomputeChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/recompute`,
    tags: ['change-sets'],
    summary: 'Recompute a store pull from the live store listing and the current repository',
    description:
      "For a change set made by the store pull (`origin.source` is `store_pull`; older change sets and other sources answer 409 `not_recomputable`). The pull is planned again from its stored request, the latest stored store snapshot (or a fresh read with `refresh`) and the repository now, and the files of the SAME change set are replaced: same id and creator, status `draft`, approval cleared (`approvalCleared`). Allowed for a draft, approved or failed change set without a branch; one with a branch answers 409 `has_branch` (use `POST /change-sets/{id}/fixup` with `recompute`). The answer has the shape of the pull plus `diffFromPrevious` (per field: `store_changed`, `unchanged`, `added`, `dropped` with a reason, such as `identical` when the store went back to the repository's text) and `nothingLeft` when the store and the repository agree now (discard it). Needs `changesets.write` and `listing.read`; `refresh` also needs `apps.sync` and is rate limited like the pull. Audited as `changeset.recompute` with counts only.",
    risk: 'write',
    access: { action: 'changesets.write' },
    body: recomputeBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description:
          'The recomputed change set, what changes, what was skipped, and what changed since the draft.',
        schema: z.object({
          changeSet: changeSetSchema,
          changes: z.array(object),
          skipped: z.array(object),
          problems: z.array(object),
          warnings: z.array(z.string()),
          diffFromPrevious: z.array(fieldDiffSchema),
          nothingLeft: z.boolean(),
          unchanged: z.boolean(),
          approvalCleared: z.boolean(),
        }),
      },
    },
  },
  {
    id: 'discardChangeSet',
    method: 'post',
    path: `${W}/change-sets/{id}/discard`,
    tags: ['change-sets'],
    summary: 'Discard a change set',
    risk: 'destructive',
    access: { action: 'changesets.write' },
    responses: { '200': changeSetAnswer },
  },
];
