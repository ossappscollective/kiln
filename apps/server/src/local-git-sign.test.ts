import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BRANCH,
  fakeProgram,
  GPG,
  git,
  gpgKey,
  gpgSigner,
  SSH_ADD,
  SSH_AGENT,
  SSH_KEYGEN,
  SUBTITLE,
  scratch,
  setup,
  snapshot,
  sshKey,
  sshVerifies,
  withPrivateTmp,
} from './local-git-test-helpers.ts';
import {
  classifySigningFailure,
  createBranchCommit,
  type GitSigning,
  gitSupportsSshSigning,
  hasSignatureHeader,
  sshKeyFingerprint,
} from './services/local-git.ts';

/**
 * Signing the commit made in a local clone (ADR 0005, "Signing"). Real git, real ssh-keygen and
 * gpg when the machine has them, with throw-away keys made in temp folders. The signing setup is
 * the server's (`signing` of the input); the repository's own config must change nothing about it.
 */

type Setup = ReturnType<typeof setup>;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const commitInput = (s: Setup, over: Partial<Parameters<typeof createBranchCommit>[0]> = {}) => ({
  gitPath: s.wrapper.path,
  path: s.dir,
  roots: s.roots,
  baseBranch: 'main',
  branch: BRANCH,
  files: [SUBTITLE],
  message:
    'Update the subtitle\n\nChanged files (1):\n- fastlane/metadata/en-US/subtitle.txt (modified)',
  author: { name: 'Ada Lovelace', email: 'ada@example.com' },
  now: NOW,
  ...over,
});

const NO_SSH = SSH_KEYGEN ? undefined : 'ssh-keygen is not installed';
const sshSigning = (key: string, program: string, over: Partial<GitSigning> = {}): GitSigning => ({
  format: 'ssh',
  key,
  program,
  ...over,
});

const commitObject = (dir: string, sha: string) => git(dir, 'cat-file', 'commit', sha);
const unchanged = (before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) =>
  assert.deepEqual(after, before);

// ---------------------------------------------------------------------------------------------
// ssh

test('ssh: the commit is signed with the server key; the object holds a signature and verify-commit accepts it', {
  skip: NO_SSH,
}, async () => {
  const s = setup();
  const k = sshKey();
  const before = snapshot(s.dir);
  const done = await createBranchCommit(
    commitInput(s, { signing: sshSigning(k.key, SSH_KEYGEN ?? '') }),
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.deepEqual(done.signature, { format: 'ssh' });
  assert.match(commitObject(s.dir, done.commit), /^gpgsig -----BEGIN SSH SIGNATURE-----$/m);
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), done.commit);
  assert.equal(sshVerifies(s.dir, done.commit, k.signers), true, 'a good signature by that key');
  assert.equal(sshVerifies(s.dir, done.commit, sshKey().signers), false, 'and not by another key');
  // The same commit as an unsigned one, apart from the signature: same tree, parent, author, message.
  const plain = await createBranchCommit(commitInput(s, { branch: 'mrm/plain' }));
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  assert.equal(plain.tree, done.tree);
  assert.equal(
    git(s.dir, 'log', '-1', '--format=%P|%an|%ae|%at|%B', done.commit),
    git(s.dir, 'log', '-1', '--format=%P|%an|%ae|%at|%B', plain.commit),
  );
  assert.equal(commitObject(s.dir, plain.commit).includes('gpgsig'), false);
  // The person's folder: byte-identical but for the two new refs.
  const after = snapshot(s.dir);
  assert.deepEqual({ ...after, refs: '' }, { ...before, refs: '' });
  git(s.dir, 'fsck', '--strict');
});

test('ssh: the key file is only read by ssh-keygen: nothing of the key is in the commit, the refs or the objects', {
  skip: NO_SSH,
}, async () => {
  const s = setup();
  const k = sshKey();
  const done = await createBranchCommit(
    commitInput(s, { signing: sshSigning(k.key, SSH_KEYGEN ?? '') }),
  );
  assert.equal(done.ok, true);
  if (!done.ok) return;
  const body =
    readFileSync(k.key, 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('-----'))[0] ?? 'x';
  const everything = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], {
    cwd: s.dir,
    encoding: 'utf8',
  });
  assert.equal(everything.includes(body), false, 'no private key material in the repository');
  assert.equal(JSON.stringify(done).includes(k.key), false, 'no key path in the result');
});

test('ssh: the signing program sees a private HOME, only the variables we chose, and no agent socket for a private key file', {
  skip: NO_SSH,
}, async () => {
  const s = setup();
  const k = sshKey();
  const spy = fakeProgram('ssh-keygen', SSH_KEYGEN);
  const previous = { secret: process.env.KILN_MASTER_KEY, sock: process.env.SSH_AUTH_SOCK };
  process.env.KILN_MASTER_KEY = 'sentinel-master-key';
  process.env.SSH_AUTH_SOCK = '/tmp/should-not-pass.sock';
  try {
    const done = await withPrivateTmp(async (tmp) => {
      const result = await createBranchCommit(
        commitInput(s, { signing: sshSigning(k.key, spy.path) }),
      );
      assert.deepEqual(readdirSync(tmp), [], 'the temporary folders (index, home) are removed');
      return result;
    });
    assert.equal(done.ok, true, JSON.stringify(done));
  } finally {
    if (previous.secret === undefined) delete process.env.KILN_MASTER_KEY;
    else process.env.KILN_MASTER_KEY = previous.secret;
    if (previous.sock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous.sock;
  }
  const lines = spy.lines();
  assert.match(lines.find((l) => l.startsWith('args:')) ?? '', /^args:-Y sign -n git -f /);
  assert.match(
    lines.find((l) => l.startsWith('home:')) ?? '',
    /^home:.*mrm-index-[^/]+\/home$/,
    'a private HOME, not the real one',
  );
  assert.equal(
    lines.find((l) => l.startsWith('sock:')),
    'sock:unset',
  );
  assert.equal(
    lines.find((l) => l.startsWith('gnupg:')),
    'gnupg:unset',
  );
  assert.equal(
    lines.find((l) => l.startsWith('secret:')),
    'secret:unset',
    'the server secrets do not reach the program',
  );
});

test('ssh with a .pub key: the agent socket given in the signing setup is passed on, a passphrase key held only by the agent signs', {
  skip: NO_SSH ?? (SSH_AGENT && SSH_ADD ? undefined : 'ssh-agent is not installed'),
}, async () => {
  const s = setup();
  const k = sshKey('correct horse');
  const askpass = join(scratch(), 'askpass.sh');
  writeFileSync(askpass, `#!/bin/sh\necho '${k.passphrase}'\n`);
  chmodSync(askpass, 0o700);
  const agent = execFileSync(SSH_AGENT ?? '', ['-s'], { encoding: 'utf8' });
  const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(agent)?.[1] ?? '';
  const pid = /SSH_AGENT_PID=(\d+);/.exec(agent)?.[1] ?? '';
  try {
    const locked = await createBranchCommit(
      commitInput(s, { signing: sshSigning(k.pub, SSH_KEYGEN ?? '') }),
    );
    assert.equal(locked.ok, false, 'a locked key and no agent: not signed');
    if (!locked.ok) assert.equal(locked.reason, 'locked');
    assert.equal(git(s.dir, 'for-each-ref', 'refs/heads/mrm'), '');

    execFileSync(SSH_ADD ?? '', [k.key], {
      env: {
        PATH: process.env.PATH ?? '',
        SSH_AUTH_SOCK: sock,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'none',
      },
      stdio: 'ignore',
    });
    const spy = fakeProgram('ssh-keygen', SSH_KEYGEN);
    const done = await createBranchCommit(
      commitInput(s, { signing: sshSigning(k.pub, spy.path, { sshAuthSock: sock }) }),
    );
    assert.equal(done.ok, true, JSON.stringify(done));
    if (!done.ok) return;
    assert.equal(sshVerifies(s.dir, done.commit, k.signers), true);
    assert.equal(
      spy.lines().find((l) => l.startsWith('sock:')),
      `sock:${sock}`,
    );
  } finally {
    if (pid) execFileSync('kill', [pid]);
  }
});

// ---------------------------------------------------------------------------------------------
// gpg

test('gpg: the commit is signed with the server key from the configured keyring, with prompts forbidden', async (t) => {
  const made = gpgKey();
  if ('skip' in made) return t.skip(made.skip);
  const s = setup();
  const spy = fakeProgram('gpg', GPG);
  const before = snapshot(s.dir);
  const done = await withPrivateTmp(async (tmp) => {
    const result = await createBranchCommit(
      commitInput(s, {
        signing: { format: 'gpg', key: made.fingerprint, program: spy.path, gnupgHome: made.home },
      }),
    );
    assert.deepEqual(readdirSync(tmp), [], 'the wrapper and the private HOME are removed');
    return result;
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.deepEqual(done.signature, { format: 'gpg' });
  assert.match(commitObject(s.dir, done.commit), /^gpgsig -----BEGIN PGP SIGNATURE-----$/m);
  assert.equal(gpgSigner(s.dir, done.commit, made.home), made.fingerprint);
  const args = spy.lines().find((l) => l.startsWith('args:')) ?? '';
  assert.match(
    args,
    /^args:--batch --no-tty --pinentry-mode error --status-fd=2 -bsau [0-9A-F]{40}$/,
  );
  assert.equal(
    spy.lines().find((l) => l.startsWith('gnupg:')),
    `gnupg:${made.home}`,
  );
  assert.match(spy.lines().find((l) => l.startsWith('home:')) ?? '', /mrm-index-[^/]+\/home$/);
  const after = snapshot(s.dir);
  assert.deepEqual({ ...after, refs: '' }, { ...before, refs: '' });
});

test('gpg: a passphrase-protected key that no agent has unlocked fails at once, without a prompt, and nothing is written', async (t) => {
  const made = gpgKey('hunter2');
  if ('skip' in made) return t.skip(made.skip);
  const s = setup();
  const before = snapshot(s.dir);
  const started = Date.now();
  const done = await createBranchCommit(
    commitInput(s, {
      signing: {
        format: 'gpg',
        key: made.fingerprint,
        program: GPG ?? '',
        gnupgHome: made.home,
        timeoutMs: 15_000,
      },
    }),
  );
  assert.equal(done.ok, false);
  if (done.ok) return;
  assert.equal(done.code, 'signing_failed');
  assert.ok(Date.now() - started < 14_000, 'it did not wait for a prompt');
  assert.equal(JSON.stringify(done).includes(made.home), false);
  assert.equal(JSON.stringify(done).includes('hunter2'), false);
  unchanged(before, snapshot(s.dir));
});

test('gpg: an unknown key id fails with signing_failed and nothing is written', async (t) => {
  const made = gpgKey();
  if ('skip' in made) return t.skip(made.skip);
  const s = setup();
  const before = snapshot(s.dir);
  const done = await createBranchCommit(
    commitInput(s, {
      signing: { format: 'gpg', key: 'DEADBEEFDEADBEEF', program: GPG ?? '', gnupgHome: made.home },
    }),
  );
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.code, 'signing_failed');
  unchanged(before, snapshot(s.dir));
});

test('gpg: a program path with a quote is refused before anything runs', async () => {
  const s = setup();
  const before = snapshot(s.dir);
  const done = await createBranchCommit(
    commitInput(s, {
      signing: {
        format: 'gpg',
        key: 'DEADBEEF',
        program: "/bin/gpg'; touch /tmp/x; '",
        gnupgHome: '/tmp',
      },
    }),
  );
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.reason, 'program');
  unchanged(before, snapshot(s.dir));
});

// ---------------------------------------------------------------------------------------------
// Failures: never an unsigned commit, never a ref

test('signing fails: refs, working tree, index and HEAD are untouched, the answer is fixed words, nothing leaks, nothing is left behind', {
  skip: NO_SSH,
}, async () => {
  const good = sshKey();
  const locked = sshKey('secret passphrase');
  const garbage = join(scratch(), 'garbage-key');
  writeFileSync(
    garbage,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----\n',
  );
  chmodSync(garbage, 0o600);
  const slow = fakeProgram(
    'slow-signer',
    undefined,
    'echo $$ > "$(dirname "$0")/pid"\nexec sleep 30\n',
  );
  const silent = fakeProgram('silent-signer', undefined, 'exit 0\n');
  const cases: { name: string; signing: GitSigning; reason: string }[] = [
    {
      name: 'a key file that is not a key',
      signing: sshSigning(garbage, SSH_KEYGEN ?? ''),
      reason: 'key',
    },
    {
      name: 'a key file that is gone',
      signing: sshSigning(join(scratch(), 'missing'), SSH_KEYGEN ?? ''),
      reason: 'key',
    },
    {
      name: 'a passphrase-protected key and no agent',
      signing: sshSigning(locked.key, SSH_KEYGEN ?? ''),
      reason: 'locked',
    },
    {
      name: 'a program that does not exist',
      signing: sshSigning(good.key, '/nonexistent/ssh-keygen'),
      reason: 'program',
    },
    {
      name: 'a program that makes no signature',
      signing: sshSigning(good.key, silent.path),
      reason: 'failed',
    },
    {
      name: 'a program that never answers',
      signing: sshSigning(good.key, slow.path, { timeoutMs: 600 }),
      reason: 'timeout',
    },
  ];
  for (const c of cases) {
    const s = setup();
    git(s.dir, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(s.dir, 'README.md'), 'edited, not staged\n');
    const before = snapshot(s.dir);
    const started = Date.now();
    const done = await withPrivateTmp(async (tmp) => {
      const result = await createBranchCommit(
        commitInput(s, { baseBranch: 'main', signing: c.signing }),
      );
      assert.deepEqual(readdirSync(tmp), [], `${c.name}: temporary folders removed`);
      return result;
    });
    assert.equal(done.ok, false, c.name);
    if (done.ok) return;
    assert.equal(done.code, 'signing_failed', c.name);
    assert.equal(done.reason, c.reason, c.name);
    assert.ok(Date.now() - started < 10_000, `${c.name}: no hang`);
    unchanged(before, snapshot(s.dir));
    assert.equal(
      git(s.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/mrm'),
      '',
      `${c.name}: no branch`,
    );
    const text = JSON.stringify(done);
    for (const secret of [
      c.signing.key,
      good.key,
      locked.key,
      garbage,
      'secret passphrase',
      'not a key',
    ]) {
      assert.equal(
        text.includes(secret),
        false,
        `${c.name}: the answer does not mention ${secret.slice(0, 12)}`,
      );
    }
    assert.match(done.message, /\w/);
  }
  // The slow program was killed, not left running.
  const pid = Number(readFileSync(join(slow.path, '..', 'pid'), 'utf8').trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), 'the process group was killed');
  assert.equal(existsSync(join(silent.path, '..', 'pid')), false);
});

// ---------------------------------------------------------------------------------------------
// The repository's config decides nothing

const HOSTILE = (evil: string, key: string) =>
  [
    '',
    '[commit]',
    '\tgpgsign = false',
    '[gpg]',
    '\tformat = openpgp',
    `\tprogram = ${evil}`,
    '[gpg "ssh"]',
    `\tprogram = ${evil}`,
    `\tdefaultKeyCommand = ${evil}`,
    '[gpg "openpgp"]',
    `\tprogram = ${evil}`,
    '[user]',
    `\tsigningkey = ${key}`,
    '',
  ].join('\n');

test('ssh: a hostile repository config does not change which program runs or which key signs', {
  skip: NO_SSH,
}, async () => {
  const s = setup();
  const mine = sshKey();
  const theirs = sshKey();
  const evil = fakeProgram('evil', undefined, 'touch "$(dirname "$0")/evil-ran"\nexit 1\n');
  const pinned = fakeProgram('ssh-keygen', SSH_KEYGEN);
  const config = join(s.dir, '.git', 'config');
  writeFileSync(config, readFileSync(config, 'utf8') + HOSTILE(evil.path, theirs.key));
  const done = await createBranchCommit(
    commitInput(s, { signing: sshSigning(mine.key, pinned.path) }),
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(
    existsSync(join(evil.path, '..', 'evil-ran')),
    false,
    'the repository program never ran',
  );
  assert.equal(evil.lines().length, 0);
  assert.equal(
    pinned.lines().filter((l) => l.startsWith('args:')).length,
    1,
    'the pinned program ran once',
  );
  assert.equal(sshVerifies(s.dir, done.commit, mine.signers), true, 'signed by the server key');
  assert.equal(
    sshVerifies(s.dir, done.commit, theirs.signers),
    false,
    'not by the key the repository names',
  );
});

test('gpg: a hostile repository config does not change which program runs or which key signs', async (t) => {
  const made = gpgKey();
  if ('skip' in made) return t.skip(made.skip);
  const s = setup();
  const evil = fakeProgram('evil', undefined, 'touch "$(dirname "$0")/evil-ran"\nexit 1\n');
  const pinned = fakeProgram('gpg', GPG);
  const config = join(s.dir, '.git', 'config');
  writeFileSync(config, readFileSync(config, 'utf8') + HOSTILE(evil.path, 'DEADBEEFDEADBEEF'));
  const done = await createBranchCommit(
    commitInput(s, {
      signing: { format: 'gpg', key: made.fingerprint, program: pinned.path, gnupgHome: made.home },
    }),
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(existsSync(join(evil.path, '..', 'evil-ran')), false);
  assert.equal(evil.lines().length, 0);
  assert.equal(pinned.lines().filter((l) => l.startsWith('args:')).length, 1);
  assert.equal(gpgSigner(s.dir, done.commit, made.home), made.fingerprint);
});

test('off: nothing is signed whatever the repository config asks for, and no signing program runs', async () => {
  const s = setup();
  const evil = fakeProgram('evil', undefined, 'touch "$(dirname "$0")/evil-ran"\nexit 1\n');
  const config = join(s.dir, '.git', 'config');
  writeFileSync(
    config,
    readFileSync(config, 'utf8') +
      HOSTILE(evil.path, 'DEADBEEFDEADBEEF').replace('gpgsign = false', 'gpgsign = true'),
  );
  const done = await createBranchCommit(commitInput(s));
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(done.signature, undefined);
  assert.equal(commitObject(s.dir, done.commit).includes('gpgsig'), false);
  assert.equal(existsSync(join(evil.path, '..', 'evil-ran')), false);
  const calls = s.wrapper
    .calls()
    .map((c) => c.args)
    .join('\n');
  assert.equal(
    /gpg\.format|user\.signingkey|commit-tree .* -S/.test(calls),
    false,
    'no signing option was passed to git',
  );
});

// ---------------------------------------------------------------------------------------------
// Small pieces

test('hasSignatureHeader: a signature header of the right format, in the headers only', () => {
  const ssh =
    'tree abc\nparent def\nauthor a <a@b.c> 1 +0000\ncommitter a <a@b.c> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nmessage\n';
  assert.equal(hasSignatureHeader(ssh, 'ssh'), true);
  assert.equal(hasSignatureHeader(ssh, 'gpg'), false, 'an ssh signature is not an openpgp one');
  assert.equal(
    hasSignatureHeader(
      'tree abc\nauthor a <a@b.c> 1 +0000\n\ngpgsig -----BEGIN SSH SIGNATURE-----\n',
      'ssh',
    ),
    false,
    'a message line that looks like a header does not count',
  );
  assert.equal(hasSignatureHeader('tree abc\n\nmessage\n', 'ssh'), false);
  assert.equal(
    hasSignatureHeader(ssh.replace('gpgsig ', 'gpgsig-sha256 ').replace(/SSH/g, 'PGP'), 'gpg'),
    true,
  );
});

test('classifySigningFailure: fixed words per class, never the program output', () => {
  const run = (stderr: string, failed?: 'timeout' | 'missing') =>
    classifySigningFailure({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr,
      ...(failed ? { failed } : {}),
    });
  assert.equal(run('', 'timeout').reason, 'timeout');
  assert.equal(
    run('error: Enter passphrase: Load key "/home/ada/.ssh/id": incorrect passphrase supplied')
      .reason,
    'locked',
  );
  assert.equal(
    run('fatal: cannot run /opt/x/ssh-keygen: No such file or directory').reason,
    'program',
  );
  assert.equal(
    run("error: Couldn't load public key /home/ada/.ssh/id: No such file or directory?").reason,
    'key',
  );
  assert.equal(run('error: gpg failed to sign the data').reason, 'failed');
  for (const stderr of [
    'error: Load key "/home/ada/.ssh/id": invalid format',
    'secret-token-123 cannot run /x/gpg',
  ]) {
    const { message } = run(stderr);
    assert.equal(message.includes('/home/ada'), false);
    assert.equal(message.includes('secret-token'), false);
  }
});

test('gitSupportsSshSigning: git 2.34 and later', () => {
  for (const [version, ok] of [
    ['2.34.0', true],
    ['2.34.1', true],
    ['2.33.9', false],
    ['2.43.0', true],
    ['2.39.5 (Apple Git-154)', true],
    ['3.0.0', true],
    ['1.9.1', false],
    ['nonsense', false],
  ] as const) {
    assert.equal(gitSupportsSshSigning(version), ok, version);
  }
});

test('sshKeyFingerprint: the public fingerprint, or nothing; never a prompt', {
  skip: NO_SSH,
}, async () => {
  const open = sshKey();
  const locked = sshKey('pw');
  assert.match(
    (await sshKeyFingerprint(SSH_KEYGEN ?? '', open.key)) ?? '',
    /^SHA256:[A-Za-z0-9+/]{43}$/,
  );
  assert.match((await sshKeyFingerprint(SSH_KEYGEN ?? '', locked.pub)) ?? '', /^SHA256:/);
  assert.equal(await sshKeyFingerprint(SSH_KEYGEN ?? '', join(scratch(), 'missing')), undefined);
  assert.equal(await sshKeyFingerprint('/nonexistent/ssh-keygen', open.key), undefined);
});
