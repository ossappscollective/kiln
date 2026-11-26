import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, versionFiles } from '../check-version.mjs';
import {
  baseline,
  bumpVersion,
  CHANGELOG_HEADER,
  compareVersions,
  decideBump,
  groupCommits,
  nextVersion,
  parseCommit,
  prependChangelog,
  renderSection,
  sortTags,
} from './bump.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repo, 'scripts/release/bump.mjs');
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const commit = (message, hash = 'abcdef0123456789') => parseCommit(message, hash);
const level = (messages, major = 0) =>
  decideBump(
    messages.map((m) => commit(m)),
    { major },
  );

describe('parseCommit', () => {
  test('type, scope and subject', () => {
    const c = commit('feat(api): add the thing\n\nbody');
    assert.equal(c.type, 'feat');
    assert.equal(c.scope, 'api');
    assert.equal(c.subject, 'add the thing');
    assert.equal(c.breaking, false);
    assert.equal(c.short, 'abcdef0');
    assert.equal(c.conventional, true);
  });
  test('no scope, and the type is lower-cased', () => {
    const c = commit('Fix: crash on start');
    assert.deepEqual([c.type, c.scope, c.subject], ['fix', '', 'crash on start']);
  });
  test('a bang marks a breaking change, with or without a scope', () => {
    assert.equal(commit('feat!: drop node 20').breaking, true);
    assert.equal(commit('refactor(db)!: rename tables').breaking, true);
  });
  test('a BREAKING CHANGE footer marks a breaking change and keeps its text', () => {
    const c = commit(
      'fix: stricter\n\nBody.\n\nBREAKING CHANGE: inputs must be UTF-8\nand trimmed\n\nRefs: #4',
    );
    assert.equal(c.breaking, true);
    assert.equal(c.breakingNote, 'inputs must be UTF-8 and trimmed');
    assert.equal(commit('feat: x\n\nBREAKING-CHANGE: y').breaking, true);
  });
  test('the words in a body without the footer form are not breaking', () => {
    assert.equal(commit('feat: x\n\nthis is not a BREAKING CHANGE: really').breaking, false);
  });
  test('messages that are not conventional are "other" and keep their first line', () => {
    const c = commit('Screenshot shot 03 opens the Assets step\n\nmore');
    assert.deepEqual([c.type, c.conventional], ['other', false]);
    assert.equal(c.subject, 'Screenshot shot 03 opens the Assets step');
    assert.equal(commit('Merge branch main').type, 'other');
    assert.equal(commit('').subject, '');
  });
  test('git revert messages are reverts', () => {
    const c = commit('Revert "feat: add the thing"\n\nThis reverts commit abc.');
    assert.deepEqual([c.type, c.subject], ['revert', 'feat: add the thing']);
  });
  test('CRLF line endings are accepted', () => {
    assert.equal(commit('feat(a): b\r\n\r\nBREAKING CHANGE: c\r\n').breaking, true);
  });
});

describe('decideBump', () => {
  test('breaking is major from 1.0 on and minor while the major version is 0', () => {
    assert.equal(level(['feat!: x', 'fix: y'], 1), 'major');
    assert.equal(level(['fix: y\n\nBREAKING CHANGE: z'], 2), 'major');
    assert.equal(level(['feat!: x', 'fix: y'], 0), 'minor');
    assert.equal(level(['fix!: x'], 0), 'minor');
  });
  test('feat is minor, also while the major version is 0', () => {
    assert.equal(level(['fix: a', 'feat(ui): b'], 3), 'minor');
    assert.equal(level(['feat: b'], 0), 'minor');
  });
  test('fix, perf and revert are patch', () => {
    for (const m of ['fix: a', 'perf: a', 'revert: a', 'Revert "chore: a"']) {
      assert.equal(level([m, 'docs: d']), 'patch', m);
    }
  });
  test('other commits make a patch release only because there is at least one', () => {
    assert.equal(level(['chore: deps', 'docs: readme', 'refactor: x', 'Some free text']), 'patch');
    for (const type of ['style', 'test', 'ci', 'build']) {
      assert.equal(level([`${type}: x`]), 'patch');
    }
  });
  test('no commits, or only release commits, is nothing to release', () => {
    assert.equal(level([]), null);
    assert.equal(level(['chore(release): 1.2.3', 'chore(release): 1.2.4']), null);
  });
  test('release commits never raise the level', () => {
    assert.equal(level(['chore(release): 1.2.3\n\nBREAKING CHANGE: nope', 'fix: a'], 1), 'patch');
  });
});

describe('versions and tags', () => {
  test('bumpVersion', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
    assert.equal(bumpVersion('0.0.0', 'minor'), '0.1.0');
    assert.equal(bumpVersion('1.3.0-rc.2', 'patch'), '1.3.1');
    assert.throws(() => bumpVersion('1.2', 'patch'), /not a valid/);
    assert.throws(() => bumpVersion('1.2.3', 'huge'), /bump must be/);
  });
  test('compareVersions follows Semantic Versioning precedence', () => {
    const order = (
      '0.9.0 1.0.0-alpha 1.0.0-alpha.1 1.0.0-alpha.beta 1.0.0-beta.2 1.0.0-beta.11 ' +
      '1.0.0-rc.1 1.0.0 1.0.1 1.10.0 2.0.0'
    ).split(' ');
    for (let i = 0; i + 1 < order.length; i++) {
      assert.ok(compareVersions(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
      assert.ok(compareVersions(order[i + 1], order[i]) > 0);
    }
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });
  test('sortTags sorts by version, not by name, and drops other tags', () => {
    const tags = ['v1.10.0', 'v1.2.0', 'v1.10.0-rc.1', 'latest', 'v2', 'v1.9.0', 'nightly-1'];
    assert.deepEqual(sortTags(tags), ['v1.2.0', 'v1.9.0', 'v1.10.0-rc.1', 'v1.10.0']);
  });
  test('the baseline is the newest stable tag, else the files', () => {
    assert.deepEqual(baseline(['v1.2.0', 'v1.10.0', 'v1.11.0-rc.1'], '0.0.0'), {
      tag: 'v1.10.0',
      version: '1.10.0',
    });
    assert.deepEqual(baseline([], '0.4.2'), { tag: '', version: '0.4.2' });
    assert.deepEqual(baseline(['v1.0.0-rc.1', 'x'], '1.0.0-rc.1'), { tag: '', version: '1.0.0' });
  });
});

describe('nextVersion', () => {
  const c = (...messages) => messages.map((m) => commit(m));
  const next = (base, ...messages) => nextVersion({ base, commits: c(...messages) }).version;
  test('auto follows the commits', () => {
    assert.equal(next('1.2.3', 'fix: a'), '1.2.4');
    assert.equal(next('1.2.3', 'fix: a', 'feat: b'), '1.3.0');
    assert.equal(next('1.2.3', 'feat!: b'), '2.0.0');
    assert.equal(next('0.2.3', 'feat!: b'), '0.3.0');
    assert.equal(next('1.2.3', 'docs: b'), '1.2.4');
  });
  test('a forced level wins, also to reach 1.0.0', () => {
    const forced = (base, bump, ...messages) =>
      nextVersion({ base, commits: c(...messages), bump }).version;
    assert.equal(forced('0.9.1', 'major', 'fix: a'), '1.0.0');
    assert.equal(forced('1.2.3', 'patch', 'feat!: a'), '1.2.4');
  });
  test('no commits (or only release commits) fails with "Nothing to release"', () => {
    assert.throws(() => nextVersion({ base: '1.2.3', commits: [] }), /Nothing to release/);
    assert.throws(
      () => nextVersion({ base: '1.2.3', commits: c('chore(release): 1.2.3'), bump: 'minor' }),
      /Nothing to release/,
    );
  });
  test('pre-releases are numbered from the existing tags', () => {
    const base = { base: '1.2.0', commits: c('feat: a') };
    const pre = (prerelease, tags) => nextVersion({ ...base, prerelease, tags }).version;
    assert.equal(pre('rc', ['v1.2.0']), '1.3.0-rc.1');
    const tags = ['v1.3.0-rc.1', 'v1.3.0-rc.2', 'v1.3.0-beta.7', 'v1.4.0-rc.9'];
    assert.equal(pre('rc', tags), '1.3.0-rc.3');
    assert.equal(pre('beta', tags), '1.3.0-beta.8');
  });
  test('rejects a bad bump or pre-release identifier', () => {
    const commits = c('fix: a');
    assert.throws(() => nextVersion({ base: '1.0.0', commits, bump: 'x' }), /bump must/);
    for (const prerelease of ['1', 'r c', 'rc.1', '-rc']) {
      assert.throws(() => nextVersion({ base: '1.0.0', commits, prerelease }), /prerelease/);
    }
  });
});

describe('changelog', () => {
  const sha = (n) => `${String(n).repeat(7)}00000000000000000000000000000000`;
  const commits = [
    parseCommit('feat(api)!: remove v1\n\nBREAKING CHANGE: clients must use v2', sha(1)),
    parseCommit('fix(ui): stop the flicker', sha(2)),
    parseCommit('feat: dark mode', sha(3)),
    parseCommit('perf(db): index the lookups', sha(4)),
    parseCommit('Revert "feat: sparkles"', sha(5)),
    parseCommit('docs(readme): fix a link', sha(6)),
    parseCommit('chore: bump deps', sha(7)),
    parseCommit('Screenshot shot 03 opens the Assets step', sha(8)),
    parseCommit('chore(release): 1.1.0', sha(9)),
  ];

  test('groups in a fixed order, breaking commits only under Breaking changes', () => {
    const groups = groupCommits(commits);
    const keys = (list) => list.map((g) => g.key);
    assert.deepEqual(keys(groups), ['breaking', 'feat', 'fix', 'perf', 'revert', 'other']);
    const feat = groups.find((g) => g.key === 'feat');
    assert.deepEqual(
      feat.commits.map((x) => x.subject),
      ['dark mode'],
    );
    assert.equal(groups.find((g) => g.key === 'other').commits.length, 3);
    assert.deepEqual(keys(groupCommits([parseCommit('fix: a', sha(1))])), ['fix']);
    assert.deepEqual(groupCommits([]), []);
  });

  test('renders the section', () => {
    const text = renderSection({
      version: '2.0.0',
      date: '2026-11-25',
      repo: 'o/k',
      previousTag: 'v1.1.0',
      commits,
    });
    assert.equal(
      text,
      `## [2.0.0] - 2026-11-25

[Compare changes](https://github.com/o/k/compare/v1.1.0...v2.0.0)

### Breaking changes

- api: remove v1 (1111111)
  - clients must use v2

### Features

- dark mode (3333333)

### Fixes

- ui: stop the flicker (2222222)

### Performance

- db: index the lookups (4444444)

### Reverts

- feat: sparkles (5555555)

### Other

- docs(readme): fix a link (6666666)
- chore: bump deps (7777777)
- Screenshot shot 03 opens the Assets step (8888888)
`,
    );
  });

  test('without a previous tag the link lists the commits; without a repo there is none', () => {
    const one = [parseCommit('fix: a', sha(1))];
    assert.match(
      renderSection({ version: '0.1.0', date: 'd', repo: 'o/k', commits: one }),
      /\[All commits\]\(https:\/\/github\.com\/o\/k\/commits\/v0\.1\.0\)/,
    );
    assert.doesNotMatch(renderSection({ version: '0.1.0', date: 'd', commits: one }), /\]\(http/);
  });

  test('prependChangelog creates the file, then puts new sections on top', () => {
    const first = renderSection({ version: '0.1.0', date: '2026-01-01', commits: [commits[1]] });
    const second = renderSection({ version: '0.2.0', date: '2026-02-01', commits: [commits[2]] });
    const created = prependChangelog('', first);
    assert.ok(created.startsWith(CHANGELOG_HEADER));
    const both = prependChangelog(created, second);
    assert.ok(both.indexOf('## [0.2.0]') < both.indexOf('## [0.1.0]'));
    assert.ok(both.startsWith(CHANGELOG_HEADER));
    assert.equal(both.match(/^## \[/gm).length, 2);
    assert.match(both, /\n\n## \[0\.1\.0\]/);
  });

  test('prependChangelog keeps a hand-written file and refuses a duplicate version', () => {
    const section = renderSection({ version: '1.0.0', date: 'd', commits: [commits[1]] });
    assert.equal(prependChangelog('# Notes\n', section), `# Notes\n\n${section}`);
    assert.throws(() => prependChangelog(prependChangelog('', section), section), /already has/);
  });
});

describe('command line', () => {
  const git = (root, ...args) => {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const say = (root, message) => git(root, 'commit', '--allow-empty', '-q', '-m', message);

  /** A git repository holding a copy of the version files and no commits. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'kiln-bump-'));
    temps.push(root);
    for (const [path] of versionFiles(repo)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repo, path), join(root, path));
    }
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    return root;
  }
  const run = (root, args, env = {}) =>
    spawnSync(process.execPath, [script, ...args, '--root', root, '--repo', 'o/k'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', ...env },
    });

  test('no tag: the version in the files is the base and every commit counts', () => {
    const root = fixture();
    say(root, 'feat: first');
    say(root, 'fix: second');
    const res = run(root, ['next', '--date', '2026-03-04', '--print-section']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Base: 0\.0\.0 from the version files/);
    assert.match(res.stdout, /Commits since: 2/);
    assert.match(res.stdout, /Next version: 0\.1\.0 \(tag v0\.1\.0\)/);
    assert.match(res.stdout, /## \[0\.1\.0\] - 2026-03-04/);
    assert.match(res.stdout, /Dry run/);
    // Dry run: the files did not change and no CHANGELOG.md appeared.
    assert.deepEqual(check(root, '0.0.0'), []);
    assert.throws(() => readFileSync(join(root, 'CHANGELOG.md')));
  });

  test('since the newest tag; release commits are ignored; --write applies everything', () => {
    const root = fixture();
    say(root, 'feat: first');
    say(root, 'chore(release): 0.1.0');
    git(root, 'tag', 'v0.1.0');
    say(root, 'fix(api): second');
    say(root, 'docs: third');
    say(root, 'Merge-looking free text');
    const res = run(root, ['next', '--date', '2026-03-04', '--write']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Base: v0\.1\.0/);
    assert.match(res.stdout, /Next version: 0\.1\.1/);
    assert.deepEqual(check(root, '0.1.1'), []);
    const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(log.startsWith('# Changelog'));
    assert.match(log, /## \[0\.1\.1\] - 2026-03-04/);
    assert.match(log, /github\.com\/o\/k\/compare\/v0\.1\.0\.\.\.v0\.1\.1\)/);
    assert.match(log, /- api: second \([0-9a-f]{7}\)/);
    assert.doesNotMatch(log, /- first|chore\(release\)/);
  });

  test('no commits since the tag fails with "Nothing to release" and writes nothing', () => {
    const root = fixture();
    say(root, 'feat: first');
    git(root, 'tag', 'v0.1.0');
    say(root, 'chore(release): 0.1.0');
    const res = run(root, ['next', '--write']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Nothing to release/);
    assert.deepEqual(check(root, '0.0.0'), []);
  });

  test('--bump forces a level, --prerelease numbers the candidates, outputs are written', () => {
    const root = fixture();
    say(root, 'fix: first');
    git(root, 'tag', 'v1.0.0');
    say(root, 'fix: second');
    git(root, 'tag', 'v1.1.0-rc.1');
    say(root, 'feat: third');
    const out = join(root, 'out.txt');
    const notes = join(root, 'notes.md');
    const res = run(
      root,
      ['next', '--bump', 'minor', '--prerelease', 'rc', '--notes-out', notes, '--github-output'],
      { GITHUB_OUTPUT: out },
    );
    // The version files say 0.0.0, which is behind v1.0.0, so this is allowed.
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Bump: minor \(forced\)/);
    assert.equal(
      readFileSync(out, 'utf8'),
      [
        'version=1.1.0-rc.2',
        'major_minor=1.1',
        'prerelease=true',
        'tag=v1.1.0-rc.2',
        'bump=minor',
        'commit_count=2',
        '',
      ].join('\n'),
    );
    assert.match(readFileSync(notes, 'utf8'), /^## \[1\.1\.0-rc\.2\]/);
  });

  test('a version in the files that is ahead of the computed one is refused', () => {
    const root = fixture();
    say(root, 'fix: first');
    git(root, 'tag', 'v0.0.1');
    say(root, 'fix: second');
    assert.equal(run(root, ['next', '--bump', 'patch']).status, 0);
    // Bring the files ahead of the tag by hand, as the old manual flow did.
    const set = spawnSync(
      process.execPath,
      [join(repo, 'scripts/check-version.mjs'), '--root', root, '--set', '3.0.0'],
      { encoding: 'utf8' },
    );
    assert.equal(set.status, 0, set.stderr);
    const refused = run(root, ['next', '--bump', 'patch']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /ahead of the computed/);
  });

  test('prepend writes a saved section, the workflow path for the tag job', () => {
    const root = fixture();
    say(root, 'feat: first');
    const notes = join(root, 'notes.md');
    assert.equal(run(root, ['next', '--notes-out', notes, '--date', '2026-03-04']).status, 0);
    const res = run(root, ['prepend', '--version', '0.1.0', '--section', notes]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.1\.0\] - 2026-03-04/);
    assert.equal(run(root, ['prepend', '--version', '0.1.0', '--section', notes]).status, 1);
  });

  test('inconsistent version files, an unknown command and bad input exit 1', () => {
    const root = fixture();
    say(root, 'feat: first');
    assert.equal(run(root, ['nope']).status, 1);
    assert.equal(run(root, ['next', '--bump', 'huge']).status, 1);
    assert.equal(run(root, ['next', '--prerelease', '1']).status, 1);
    assert.equal(run(root, ['prepend']).status, 1);
  });
});
