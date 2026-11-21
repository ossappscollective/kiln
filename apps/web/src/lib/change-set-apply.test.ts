import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLY_LOCAL_EXPLANATION,
  type ApplyContext,
  applyBlocker,
  applyBody,
  applyDoneMessage,
  branchNameProblem,
  defaultApplyMode,
  defaultBranchName,
  githubPrAvailability,
  initialChoice,
  localBranchAvailability,
  localOnlyNotice,
  normalizeChoice,
  openPrAvailability,
  outcomeSignature,
  outcomeSteps,
  pushAvailability,
  retryOptions,
  signingNote,
  switchHint,
} from './change-set-apply.ts';
import type { ChangeSetView, LocalOutcome } from './types.ts';

const ON = { enabled: true, envName: 'KILN_LOCAL_REPO_WRITE' };
const OFF = {
  enabled: false,
  envName: 'KILN_LOCAL_REPO_WRITE',
  message:
    'Writing to local clones is not enabled. Set KILN_LOCAL_REPO_WRITE=true and restart the server.',
};
const github: ApplyContext = { localOnly: false, hasLocalClone: true, write: ON };
const localOnly: ApplyContext = { localOnly: true, hasLocalClone: true, write: ON };

test('a GitHub repository is applied as a pull request by default; a local-only one as a local commit', () => {
  assert.equal(defaultApplyMode(github), 'github_pr');
  assert.equal(defaultApplyMode(localOnly), 'local_branch');
  assert.deepEqual(initialChoice(github, 'kiln/x'), {
    mode: 'github_pr',
    branch: 'kiln/x',
    push: false,
    openPr: false,
  });
});

test('the pull request is not available without a GitHub connection, with a reason', () => {
  assert.equal(githubPrAvailability(github).available, true);
  const refused = githubPrAvailability(localOnly);
  assert.equal(refused.available, false);
  assert.match(refused.reason ?? '', /no GitHub connection/);
});

test('a local commit needs a clone, a known setting and writing switched on; each says why', () => {
  assert.equal(localBranchAvailability(github).available, true);
  assert.match(
    localBranchAvailability({ ...github, hasLocalClone: false }).reason ?? '',
    /No local clone is attached/,
  );
  assert.match(localBranchAvailability({ ...github, write: null }).reason ?? '', /Reload/);
  assert.match(
    localBranchAvailability({ ...github, write: OFF }).reason ?? '',
    /KILN_LOCAL_REPO_WRITE=true/,
  );
  assert.match(
    localBranchAvailability({
      ...github,
      write: { enabled: false, envName: 'KILN_LOCAL_REPO_WRITE' },
    }).reason ?? '',
    /KILN_LOCAL_REPO_WRITE=true/,
  );
});

test('push and pull request: push needs GitHub and writing; the pull request needs the push chosen', () => {
  assert.equal(pushAvailability(github).available, true);
  assert.match(pushAvailability(localOnly).reason ?? '', /nowhere to push/);
  assert.match(pushAvailability({ ...github, write: OFF }).reason ?? '', /KILN_LOCAL_REPO_WRITE/);
  assert.equal(openPrAvailability(github, true).available, true);
  assert.match(openPrAvailability(github, false).reason ?? '', /Push the branch to GitHub/);
  assert.match(openPrAvailability(localOnly, true).reason ?? '', /nowhere to push/);
});

test('a choice is normalised: no push for a pull request or a local-only repository, no pull request without a push', () => {
  const choice = { mode: 'local_branch', branch: 'b', push: true, openPr: true } as const;
  assert.deepEqual(normalizeChoice(choice, github), choice);
  assert.deepEqual(normalizeChoice(choice, localOnly), { ...choice, push: false, openPr: false });
  assert.deepEqual(normalizeChoice(choice, { ...github, write: OFF }), {
    ...choice,
    push: false,
    openPr: false,
  });
  assert.deepEqual(normalizeChoice({ ...choice, push: false }, github), {
    ...choice,
    push: false,
    openPr: false,
  });
  assert.deepEqual(normalizeChoice({ ...choice, mode: 'github_pr' }, github), {
    ...choice,
    mode: 'github_pr',
    push: false,
    openPr: false,
  });
});

test('what stops Apply is told in words: the mode is impossible, or the branch name is wrong', () => {
  assert.equal(
    applyBlocker({ mode: 'github_pr', branch: '', push: false, openPr: false }, github),
    null,
  );
  assert.match(
    applyBlocker({ mode: 'github_pr', branch: '', push: false, openPr: false }, localOnly) ?? '',
    /no GitHub connection/,
  );
  assert.match(
    applyBlocker(
      { mode: 'local_branch', branch: '', push: false, openPr: false },
      { ...localOnly, write: OFF },
    ) ?? '',
    /not enabled/,
  );
  assert.equal(
    applyBlocker({ mode: 'local_branch', branch: '', push: false, openPr: false }, localOnly),
    null,
  );
  assert.match(
    applyBlocker({ mode: 'local_branch', branch: 'a b', push: false, openPr: false }, localOnly) ??
      '',
    /letters, digits/,
  );
});

test('the default branch is kiln/ + a slug of the summary + the start of the id, as the server makes it', () => {
  assert.equal(
    defaultBranchName('1234abcd-0000-4000-8000-000000000000', 'Update the subtitle'),
    'kiln/update-the-subtitle-1234abcd',
  );
  assert.equal(
    defaultBranchName('abcdef12-0', '  Ünïcode — & symbols!! '),
    'kiln/u-ni-code-symbols-abcdef12',
  );
  assert.equal(defaultBranchName('abcdef12', '日本語'), 'kiln/update-abcdef12');
  const long = defaultBranchName('abcdef12', 'x'.repeat(100));
  assert.equal(long, `kiln/${'x'.repeat(40)}-abcdef12`);
  assert.equal(branchNameProblem(long), null);
});

test("branch names: blank is the default; the rules are the server's", () => {
  assert.equal(branchNameProblem(''), null);
  assert.equal(branchNameProblem('   '), null);
  for (const ok of ['kiln/update-1', 'release_1.2', 'a', 'feature/x.y-z', 'A/B'])
    assert.equal(branchNameProblem(ok), null, ok);
  for (const bad of [
    ' lead',
    'trail ',
    '-dash',
    '.dot',
    'a..b',
    'a//b',
    'a/.b',
    'a@{b',
    'ends/',
    'ends.',
    'x.lock',
    'a/x.lock/b',
    'HEAD',
    '@',
    'refs/heads/x',
    'has space',
    'tilde~',
    'caret^',
    'colon:',
    'star*',
    'ünï',
    'a'.repeat(201),
  ]) {
    assert.equal(typeof branchNameProblem(bad), 'string', bad);
  }
});

test('the request: nothing for a pull request; for a local commit only what differs from the default', () => {
  const d = 'kiln/default-1';
  assert.equal(applyBody({ mode: 'github_pr', branch: d, push: true, openPr: true }, d), undefined);
  assert.deepEqual(applyBody({ mode: 'local_branch', branch: d, push: false, openPr: false }, d), {
    mode: 'local_branch',
  });
  assert.deepEqual(
    applyBody({ mode: 'local_branch', branch: '  ', push: false, openPr: false }, d),
    { mode: 'local_branch' },
  );
  assert.deepEqual(
    applyBody({ mode: 'local_branch', branch: 'mine', push: true, openPr: false }, d),
    {
      mode: 'local_branch',
      branch: 'mine',
      push: true,
    },
  );
  assert.deepEqual(applyBody({ mode: 'local_branch', branch: d, push: true, openPr: true }, d), {
    mode: 'local_branch',
    push: true,
    openPr: true,
  });
  // A pull request without a push is never sent.
  assert.deepEqual(applyBody({ mode: 'local_branch', branch: d, push: false, openPr: true }, d), {
    mode: 'local_branch',
  });
});

test('the hint to look at the commit is git switch with the branch', () => {
  assert.equal(switchHint('kiln/update-1'), 'git switch kiln/update-1');
  assert.match(APPLY_LOCAL_EXPLANATION, /git switch/);
});

const outcome = (patch: Partial<LocalOutcome> = {}): LocalOutcome => ({
  mode: 'local_branch',
  base: { branch: 'main', commit: 'a'.repeat(40) },
  commit: { branch: 'kiln/x', sha: 'b'.repeat(40), at: 1 },
  requested: { push: false, openPr: false },
  push: { status: 'not_requested' },
  pr: { status: 'not_requested' },
  ...patch,
});

test('the steps of a commit: each has its own status and tone, and a failure carries its reason', () => {
  assert.deepEqual(
    outcomeSteps(outcome()).map((s) => [s.id, s.tone, s.status]),
    [
      ['commit', 'ok', 'Committed to kiln/x'],
      ['push', 'neutral', 'Not pushed'],
      ['pr', 'neutral', 'No pull request'],
    ],
  );
  const done = outcomeSteps(
    outcome({
      push: { status: 'pushed' },
      pr: { status: 'opened', url: 'https://github.com/a/b/pull/1', number: 1 },
    }),
  );
  assert.deepEqual(
    done.map((s) => s.tone),
    ['ok', 'ok', 'ok'],
  );
  const failedPush = outcomeSteps(
    outcome({
      push: { status: 'failed', error: 'GitHub declined the push.' },
      pr: { status: 'skipped' },
    }),
  );
  assert.equal(failedPush[1]?.tone, 'bad');
  assert.equal(failedPush[1]?.detail, 'GitHub declined the push.');
  assert.equal(failedPush[2]?.tone, 'warn');
  const failedPr = outcomeSteps(
    outcome({ push: { status: 'pushed' }, pr: { status: 'failed', error: 'Validation failed.' } }),
  );
  assert.equal(failedPr[2]?.tone, 'bad');
  assert.equal(failedPr[2]?.detail, 'Validation failed.');
});

const applied = (o: LocalOutcome | null): Pick<ChangeSetView, 'status' | 'outcome'> => ({
  status: 'applied',
  outcome: o,
});

test('retries: push (or retry it), then the pull request; nothing once done, for a viewer, a member, local-only or writing off', () => {
  assert.deepEqual(
    retryOptions(applied(outcome()), github, 'admin').map((o) => [o.id, o.openPr]),
    [
      ['push', false],
      ['push_pr', true],
    ],
  );
  const failed = retryOptions(
    applied(outcome({ push: { status: 'failed' }, pr: { status: 'skipped' } })),
    github,
    'owner',
  );
  assert.deepEqual(
    failed.map((o) => o.label),
    ['Retry the push', 'Retry the push and open a pull request'],
  );
  const pushed = retryOptions(applied(outcome({ push: { status: 'pushed' } })), github, 'admin');
  assert.deepEqual(
    pushed.map((o) => [o.id, o.label, o.openPr]),
    [['pr', 'Open a pull request', true]],
  );
  const prFailed = retryOptions(
    applied(outcome({ push: { status: 'pushed' }, pr: { status: 'failed' } })),
    github,
    'admin',
  );
  assert.deepEqual(
    prFailed.map((o) => o.label),
    ['Retry the pull request'],
  );
  assert.deepEqual(
    retryOptions(
      applied(outcome({ push: { status: 'pushed' }, pr: { status: 'opened' } })),
      github,
      'admin',
    ),
    [],
  );
  for (const role of ['member', 'viewer'] as const)
    assert.deepEqual(retryOptions(applied(outcome()), github, role), []);
  assert.deepEqual(retryOptions(applied(outcome()), localOnly, 'admin'), []);
  assert.deepEqual(retryOptions(applied(outcome()), { ...github, write: OFF }, 'admin'), []);
  assert.deepEqual(retryOptions(applied(null), github, 'admin'), []);
  assert.deepEqual(retryOptions({ status: 'approved', outcome: outcome() }, github, 'admin'), []);
});

test('the message after Apply says what happened to each step', () => {
  assert.equal(applyDoneMessage({ outcome: null }, undefined), 'Pull request opened.');
  assert.equal(applyDoneMessage({ outcome: null }, true), 'This change set was already applied.');
  assert.match(
    applyDoneMessage({ outcome: outcome() }, undefined),
    /Committed to kiln\/x in the local clone/,
  );
  assert.match(
    applyDoneMessage({ outcome: outcome({ push: { status: 'pushed' } }) }, undefined),
    /Committed and pushed kiln\/x/,
  );
  assert.match(
    applyDoneMessage({ outcome: outcome({ push: { status: 'failed' } }) }, undefined),
    /push failed.*commit is kept/,
  );
  assert.match(
    applyDoneMessage(
      { outcome: outcome({ push: { status: 'pushed' }, pr: { status: 'failed' } }) },
      undefined,
    ),
    /pull request was not opened/,
  );
  assert.equal(
    applyDoneMessage(
      { outcome: outcome({ push: { status: 'pushed' }, pr: { status: 'opened' } }) },
      undefined,
    ),
    'Committed, pushed and opened a pull request.',
  );
});

test('the local-only note says what apply does, and how to turn writing on when it is off', () => {
  const on = localOnlyNotice(ON);
  assert.match(on.text, /commits the files to a new branch/);
  assert.doesNotMatch(on.text, /not enabled/);
  const off = localOnlyNotice(OFF);
  assert.match(off.text, /KILN_LOCAL_REPO_WRITE=true/);
  assert.match(localOnlyNotice(null).text, /KILN_LOCAL_REPO_WRITE=true/);
  for (const note of [on, off])
    assert.doesNotMatch(`${note.title} ${note.text}`, /not available yet|cannot be applied yet/);
});

// ----- signing -----------------------------------------------------------------------------------

test('the Apply dialog says whether the commit will be signed, and how; nothing when the server did not say', () => {
  assert.deepEqual(signingNote({ enabled: true, format: 'ssh' }), {
    signed: true,
    text: 'The commit will be signed (ssh).',
  });
  assert.equal(
    signingNote({ enabled: true, format: 'gpg' })?.text,
    'The commit will be signed (gpg).',
  );
  assert.equal(signingNote({ enabled: true })?.text, 'The commit will be signed.');
  assert.deepEqual(signingNote({ enabled: false }), {
    signed: false,
    text: 'Commits are not signed (set KILN_GIT_SIGN to enable).',
  });
  assert.equal(signingNote(null), null);
  assert.equal(signingNote(undefined), null, 'an older server has no signing field');
});

test('the explanation of a local commit no longer says that signing never runs', () => {
  assert.doesNotMatch(APPLY_LOCAL_EXPLANATION, /signing do not run/i);
  assert.match(APPLY_LOCAL_EXPLANATION, /Hooks do not run/);
});

test('a signed outcome has a badge and a tip that says Verified depends on the GitHub account; an unsigned one has neither', () => {
  const signed = outcomeSignature({ signature: { status: 'signed', format: 'ssh' } });
  assert.equal(signed?.label, 'Signed (ssh)');
  assert.match(signed?.tip ?? '', /Verified/);
  assert.match(signed?.tip ?? '', /signing key/);
  assert.match(
    signed?.tip ?? '',
    /not checked here/,
    'it does not claim the signature was verified',
  );
  const gpg = outcomeSignature({ signature: { status: 'signed', format: 'gpg' } });
  assert.equal(gpg?.label, 'Signed (gpg)');
  assert.match(gpg?.tip ?? '', /GPG key/);
  assert.equal(outcomeSignature({}), null);
  assert.equal(outcomeSignature(null), null);
});

test('signing does not change what can be applied or pushed', () => {
  const signedContext: ApplyContext = { ...github, signing: { enabled: true, format: 'ssh' } };
  assert.deepEqual(localBranchAvailability(signedContext), localBranchAvailability(github));
  assert.deepEqual(pushAvailability(signedContext), pushAvailability(github));
});
