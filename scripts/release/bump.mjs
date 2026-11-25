#!/usr/bin/env node
// Next version and changelog from Conventional Commits. Used by the Release workflow for a
// manual release (no tag created by hand) and runnable locally as a dry run. See
// docs/releasing.md.
//
//   node scripts/release/bump.mjs next [options]       compute, print, optionally write
//     --bump auto|patch|minor|major    default auto: decided by the commits (see decideBump)
//     --prerelease rc                  1.3.0-rc.1, then rc.2 ...; empty: a stable release
//     --repo owner/name                for links; default $GITHUB_REPOSITORY or the origin remote
//     --date YYYY-MM-DD                changelog date; default today (UTC)
//     --notes-out file                 write the changelog section (Markdown) to this file
//     --print-section                  print the changelog section after the summary
//     --github-output                  append version, tag, major_minor, prerelease, bump,
//                                      commit_count to $GITHUB_OUTPUT
//     --write                          write the version files and prepend CHANGELOG.md
//     --root dir                       repository root (default: this checkout)
//   node scripts/release/bump.mjs prepend --version X.Y.Z --section file [--root dir]
//                                                      prepend a saved section to CHANGELOG.md
//
// Without --write nothing in the repository changes. The base is the newest stable v* tag (by
// Semantic Versioning order, not by name) and the commits are those since it; with no stable tag
// the base is the version in the files and every commit counts. No dependencies, no network.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, parseVersion, readVersions, setVersion } from '../check-version.mjs';

export const LEVELS = ['patch', 'minor', 'major'];

export const CHANGELOG_HEADER = `# Changelog

All notable changes to Kiln are listed here, newest first. Each section is generated from the
[Conventional Commits](https://www.conventionalcommits.org/) since the previous release by
\`scripts/release/bump.mjs\` when a release is cut (see docs/releasing.md).
`;

// type(scope)!: subject
const HEADER = /^(\w+)(?:\(([^()\n]+)\))?(!)?:[ \t]+(.+)$/;
// "BREAKING CHANGE: text" or "BREAKING-CHANGE: text" at the start of a line; the text runs to
// the next blank line.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:[ \t]*([^\n]*(?:\n[^\n]+)*)/m;

/**
 * One commit message -> { hash, short, type, scope, subject, conventional, breaking,
 * breakingNote }. A message that is not "type: subject" has type "other" and keeps its first
 * line as the subject. `Revert "..."` (what `git revert` writes) is a revert.
 */
export function parseCommit(message, hash = '') {
  const text = message.replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  const header = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n');
  const commit = {
    hash,
    short: hash.slice(0, 7),
    type: 'other',
    scope: '',
    subject: header,
    conventional: false,
    breaking: false,
    breakingNote: '',
  };
  const m = HEADER.exec(header);
  const revert = /^Revert "(.+)"$/.exec(header);
  if (m) {
    commit.type = m[1].toLowerCase();
    commit.scope = (m[2] ?? '').trim();
    commit.subject = m[4].trim();
    commit.conventional = true;
    commit.breaking = m[3] === '!';
  } else if (revert) {
    commit.type = 'revert';
    commit.subject = revert[1];
    commit.conventional = true;
  }
  const footer = BREAKING_FOOTER.exec(body);
  if (footer) {
    commit.breaking = true;
    commit.breakingNote = footer[1].replace(/\s*\n\s*/g, ' ').trim();
  }
  return commit;
}

/** The release commits this tool writes (`chore(release): 1.3.0`) never count. */
export function isReleaseCommit(commit) {
  return commit.type === 'chore' && commit.scope.toLowerCase() === 'release';
}

/**
 * The level the commits call for, or null when there is nothing to release.
 *   breaking            major (minor while the major version is 0)
 *   feat                minor
 *   fix, perf, revert   patch
 *   anything else       patch, only because there is at least one commit
 */
export function decideBump(commits, { major = 0 } = {}) {
  const list = commits.filter((c) => !isReleaseCommit(c));
  if (list.length === 0) return null;
  if (list.some((c) => c.breaking)) return Number(major) === 0 ? 'minor' : 'major';
  if (list.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

/** 1.2.3 + minor -> 1.3.0. Any pre-release part of `version` is dropped first. */
export function bumpVersion(version, level) {
  const v = parseVersion(version);
  if (!v) throw new Error(`"${version}" is not a valid Semantic Version.`);
  const [major, minor, patch] = [Number(v.major), Number(v.minor), Number(v.patch)];
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump must be one of ${LEVELS.join(', ')}, got "${level}".`);
}

function compareIdentifiers(a, b) {
  const numeric = (s) => /^\d+$/.test(s);
  if (numeric(a) && numeric(b)) return Number(a) - Number(b);
  if (numeric(a)) return -1;
  if (numeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic Versioning 2.0.0 precedence: negative, 0 or positive. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Cannot compare "${a}" and "${b}".`);
  for (const key of ['major', 'minor', 'patch']) {
    const d = Number(x[key]) - Number(y[key]);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  const p = x.pre.split('.');
  const q = y.pre.split('.');
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    const d = compareIdentifiers(p[i], q[i]);
    if (d !== 0) return d;
  }
  return p.length - q.length;
}

/** The vX.Y.Z[-pre] names among `names`, oldest first by Semantic Versioning order. */
export function sortTags(names) {
  return names
    .filter((n) => n.startsWith('v') && parseVersion(n.slice(1)))
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
}

/** Where the commits are counted from: { tag, version }, tag '' when no stable tag exists. */
export function baseline(tagNames, filesVersion) {
  const stable = sortTags(tagNames).filter((n) => !parseVersion(n.slice(1)).prerelease);
  const tag = stable.at(-1) ?? '';
  if (tag) return { tag, version: tag.slice(1) };
  const v = parseVersion(filesVersion);
  if (!v) throw new Error(`"${filesVersion}" is not a valid Semantic Version.`);
  return { tag: '', version: `${v.major}.${v.minor}.${v.patch}` };
}

/**
 * The next version. `base` is X.Y.Z, `commits` are parsed, `tags` are all tag names (to number a
 * pre-release). Returns { version, level, core }. Throws when there is nothing to release.
 */
export function nextVersion({ base, commits, bump = 'auto', prerelease = '', tags = [] }) {
  if (bump !== 'auto' && !LEVELS.includes(bump)) {
    throw new Error(`bump must be auto, ${LEVELS.join(', ')}; got "${bump}".`);
  }
  if (prerelease && !/^[A-Za-z][0-9A-Za-z-]*$/.test(prerelease)) {
    throw new Error(
      `prerelease "${prerelease}" must be letters, digits and "-", starting with a letter.`,
    );
  }
  const base3 = parseVersion(base);
  if (!base3) throw new Error(`"${base}" is not a valid Semantic Version.`);
  const level = bump === 'auto' ? decideBump(commits, { major: base3.major }) : bump;
  if (level === null || commits.filter((c) => !isReleaseCommit(c)).length === 0) {
    throw new Error('Nothing to release: there are no commits since the last release.');
  }
  const core = bumpVersion(base, level);
  if (!prerelease) return { version: core, level, core };
  let last = 0;
  for (const name of tags) {
    const t = name.startsWith('v') ? parseVersion(name.slice(1)) : null;
    if (!t || `${t.major}.${t.minor}.${t.patch}` !== core || !t.pre.startsWith(`${prerelease}.`)) {
      continue;
    }
    const n = Number(t.pre.slice(prerelease.length + 1));
    if (Number.isInteger(n) && n > last) last = n;
  }
  return { version: `${core}-${prerelease}.${last + 1}`, level, core };
}

const GROUPS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['revert', 'Reverts'],
  ['other', 'Other'],
];

/**
 * Commits in git order, release commits dropped -> [{ key, title, commits }]. Empty groups are
 * left out.
 */
export function groupCommits(commits) {
  const buckets = new Map(GROUPS.map(([key]) => [key, []]));
  for (const c of commits) {
    if (isReleaseCommit(c)) continue;
    let key = 'other';
    if (c.breaking) key = 'breaking';
    else if (['feat', 'fix', 'perf', 'revert'].includes(c.type)) key = c.type;
    buckets.get(key).push(c);
  }
  return GROUPS.filter(([key]) => buckets.get(key).length > 0).map(([key, title]) => ({
    key,
    title,
    commits: buckets.get(key),
  }));
}

/** `- scope: subject (sha)`. Without a scope the type labels breaking and other entries. */
export function formatEntry(commit, key) {
  let label = commit.scope;
  if (commit.conventional && (key === 'breaking' || key === 'other')) {
    if (key === 'other') label = commit.scope ? `${commit.type}(${commit.scope})` : commit.type;
    else label = commit.scope || commit.type;
  }
  const sha = commit.short ? ` (${commit.short})` : '';
  let line = `- ${label ? `${label}: ` : ''}${commit.subject}${sha}`;
  if (key === 'breaking' && commit.breakingNote && commit.breakingNote !== commit.subject) {
    line += `\n  - ${commit.breakingNote}`;
  }
  return line;
}

/**
 * The changelog section for one release:
 *   ## [1.3.0] - 2026-11-25
 *   [Compare changes](https://github.com/o/r/compare/v1.2.0...v1.3.0)
 *   ### Features ...
 */
export function renderSection({ version, date, repo = '', previousTag = '', commits }) {
  const out = [`## [${version}] - ${date}`, ''];
  if (repo && previousTag) {
    out.push(
      `[Compare changes](https://github.com/${repo}/compare/${previousTag}...v${version})`,
      '',
    );
  } else if (repo) {
    out.push(`[All commits](https://github.com/${repo}/commits/v${version})`, '');
  }
  const groups = groupCommits(commits);
  if (groups.length === 0) out.push('No notable changes.', '');
  for (const g of groups) {
    out.push(`### ${g.title}`, '', ...g.commits.map((c) => formatEntry(c, g.key)), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Puts `section` above the newest section of `existing` (or creates the file text). */
export function prependChangelog(existing, section) {
  const heading = /^## \[([^\]\n]+)\]/.exec(section)?.[1];
  if (heading && existing.includes(`## [${heading}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${heading}.`);
  }
  if (!existing.trim()) return `${CHANGELOG_HEADER}\n${section}`;
  const at = existing.search(/^## \[/m);
  if (at === -1) return `${existing.trimEnd()}\n\n${section}`;
  return `${existing.slice(0, at)}${section}\n${existing.slice(at)}`;
}

// ---------------------------------------------------------------------------------------------
// Git and files (the command line)

const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

export function listTags(root) {
  return git(root, 'tag', '--list', 'v*').split('\n').filter(Boolean);
}

/** Commits reachable from HEAD and not from `sinceTag` (all of them without one), newest first. */
export function readCommits(root, sinceTag = '') {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const raw = git(root, 'log', '--no-merges', '--format=%H%x1f%B%x1e', range);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, ...message] = record.split('\x1f');
      return parseCommit(message.join('\x1f'), hash.trim());
    });
}

function repoName(root, given) {
  const name = given || process.env.GITHUB_REPOSITORY;
  if (name) return name;
  try {
    const url = git(root, 'remote', 'get-url', 'origin').trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Everything `next` decides, without writing anything. Throws Error with a readable message. */
export function plan(root, { bump = 'auto', prerelease = '', repo = '', date = '' } = {}) {
  const problems = check(root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const filesVersion = readVersions(root).found.find((f) => f.path === 'package.json').version;
  const tags = listTags(root);
  const from = baseline(tags, filesVersion);
  const commits = readCommits(root, from.tag).filter((c) => !isReleaseCommit(c));
  const next = nextVersion({ base: from.version, commits, bump, prerelease, tags });
  if (tags.includes(`v${next.version}`)) {
    throw new Error(`The tag v${next.version} already exists.`);
  }
  if (compareVersions(filesVersion, next.core) > 0) {
    throw new Error(
      `The version files say ${filesVersion}, which is ahead of the computed ${next.version}. ` +
        `Tag that commit by hand (see "Manual tag" in docs/releasing.md) or lower the files.`,
    );
  }
  const section = renderSection({
    version: next.version,
    date: date || new Date().toISOString().slice(0, 10),
    repo: repoName(root, repo),
    previousTag: from.tag,
    commits,
  });
  return { ...next, from, commits, section, tags };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bump: { type: 'string', default: 'auto' },
      prerelease: { type: 'string', default: '' },
      repo: { type: 'string', default: '' },
      date: { type: 'string', default: '' },
      'notes-out': { type: 'string' },
      'print-section': { type: 'boolean', default: false },
      'github-output': { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      version: { type: 'string' },
      section: { type: 'string' },
      root: { type: 'string' },
    },
  });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const fail = (message) => {
    for (const line of message.split('\n')) {
      console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : `error: ${line}`);
    }
    process.exit(1);
  };
  const command = positionals[0] ?? 'next';

  try {
    if (command === 'prepend') {
      if (!values.version || !values.section) fail('prepend needs --version and --section.');
      const file = join(root, 'CHANGELOG.md');
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, prependChangelog(existing, readFileSync(values.section, 'utf8')));
      console.log(`Added ${values.version} to CHANGELOG.md.`);
      return;
    }
    if (command !== 'next') fail(`Unknown command "${command}". Use next or prepend.`);

    const r = plan(root, values);
    const kinds = groupCommits(r.commits)
      .map((g) => `${g.commits.length} ${g.key}`)
      .join(', ');
    console.log(
      r.from.tag
        ? `Base: ${r.from.tag} (newest stable tag).`
        : `Base: ${r.from.version} from the version files (no stable v* tag; every commit counts).`,
    );
    console.log(`Commits since: ${r.commits.length} (${kinds})`);
    const why = values.bump === 'auto' ? 'decided by the commits' : 'forced';
    console.log(`Bump: ${r.level} (${why})`);
    console.log(`Next version: ${r.version} (tag v${r.version})`);
    if (values['print-section']) console.log(`\n${r.section}`);
    if (values['notes-out']) writeFileSync(values['notes-out'], r.section);
    if (values['github-output'] && process.env.GITHUB_OUTPUT) {
      const info = parseVersion(r.version);
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${r.version}\nmajor_minor=${info.majorMinor}\nprerelease=${info.prerelease}\n` +
          `tag=v${r.version}\nbump=${r.level}\ncommit_count=${r.commits.length}\n`,
      );
    }
    if (values.write) {
      setVersion(root, r.version);
      const file = join(root, 'CHANGELOG.md');
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, prependChangelog(existing, r.section));
      console.log(`Wrote ${r.version} to the version files and CHANGELOG.md. Check git diff.`);
    } else {
      console.log('Dry run: nothing was written (add --write to apply it).');
    }
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
