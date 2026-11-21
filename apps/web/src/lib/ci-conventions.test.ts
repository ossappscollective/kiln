import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TAG_PATTERNS, MAX_PATTERNS } from '@kiln/core';
import {
  appendPattern,
  confidenceBadge,
  conventionSourceLabel,
  diagnosticsLines,
  draftOf,
  draftProblems,
  draftValues,
  hasDraftProblems,
  isUncertain,
  parsePatternLines,
  previewConventions,
  previewReading,
  proposeFromExample,
  rowsForBuild,
  sameDraft,
  shouldAutoRematch,
  tagFoundText,
} from './ci/ci.ts';
import type { BuildDiagnostics, RepositoryTags } from './types.ts';

const names = (
  tags: string[],
  releases: { name: string | null; tagName: string; draft?: boolean }[] = [],
): Pick<RepositoryTags, 'tags' | 'releases'> => ({
  tags: tags.map((name, i) => ({ name, sha: String(i).repeat(40).slice(0, 40) })),
  releases: releases.map((r) => ({
    name: r.name,
    tagName: r.tagName,
    draft: r.draft ?? false,
    publishedAt: null,
  })),
});

const empty = { tagText: '', releaseText: '', prefix: '', workflow: '' };

const diagnostics = (over: Partial<BuildDiagnostics> = {}): BuildDiagnostics => ({
  scannedAt: 1,
  scanOk: true,
  scanError: null,
  patterns: {
    tags: [],
    releases: [],
    prefix: '',
    workflow: null,
    usingDefaults: true,
    source: 'defaults',
  },
  tags: { seen: 5, truncated: false, sample: [], targeted: [] },
  releases: { seen: 2, truncated: false, error: null },
  newestRelease: null,
  fitting: 0,
  newestFit: null,
  runs: { stored: 3, newestAt: 5 },
  canReadTags: true,
  ...over,
});

test('the preview reads the maintainer layout with the defaults and marks the other platform', () => {
  const preview = previewConventions(
    names(['ios/appstore/1.2.3/123', 'android/playstore/1.2.3/123', 'v1.2.3', 'nightly']),
    empty,
    'ios',
  );
  assert.equal(preview.usedTagPatterns[0], DEFAULT_TAG_PATTERNS[0]);
  assert.equal(preview.tags[0]?.matched, true);
  assert.equal(preview.tags[0]?.fields?.flavor, 'appstore');
  assert.equal(preview.tags[0]?.platformOk, true);
  assert.equal(preview.tags[1]?.platformOk, false, 'an Android tag is not a fit for an iOS app');
  assert.equal(preview.tags[2]?.matched, false);
  assert.equal(preview.tags[3]?.matched, false);
  assert.equal(preview.tagFits, 1);
});

test('the preview follows the draft: its own patterns and prefix replace the defaults', () => {
  const tags = names(['scanner-ios/appstore/1.4.0/312', 'wallet-ios/appstore/1.4.0/312', 'rel-77']);
  const draft = {
    ...empty,
    tagText: '{prefix}{platform}/{flavor}/{version}/{buildNumber}\nrel-{buildNumber}',
    prefix: 'scanner-',
  };
  const preview = previewConventions(tags, draft, 'ios');
  assert.deepEqual(
    preview.tags.map((r) => r.matched),
    [true, false, true],
  );
  assert.equal(preview.tags[2]?.pattern, 'rel-{buildNumber}');
  assert.equal(preview.tagFits, 2);
  assert.equal(preview.usedTagPatterns.length, 2);
  // A prefix that is not valid is left out of the preview instead of breaking it.
  assert.doesNotThrow(() => previewConventions(tags, { ...draft, prefix: 'x'.repeat(60) }, 'ios'));
});

test('releases are read by their title, else their tag, and drafts are left out', () => {
  const preview = previewConventions(
    names(
      [],
      [
        { name: 'Weather(ios): v1.4.0 Build 312', tagName: 'x' },
        { name: null, tagName: 'ios/appstore/1.4.0/313' },
        { name: 'Weather(ios): v1.4.0 Build 314', tagName: 'y', draft: true },
      ],
    ),
    empty,
    'ios',
  );
  assert.equal(preview.releases.length, 2);
  assert.equal(preview.releases[0]?.fields?.buildNumber, '312');
  assert.equal(preview.releases[1]?.name, 'ios/appstore/1.4.0/313');
});

test('rowsForBuild keeps the rows with the number of the build, ignoring leading zeros and other platforms', () => {
  const preview = previewConventions(
    names(['ios/appstore/1.2.3/0123', 'android/playstore/1.2.3/123', 'ios/appstore/1.2.3/124']),
    empty,
    'ios',
  );
  const rows = rowsForBuild(preview.tags, '123');
  assert.deepEqual(
    rows.map((r) => r.name),
    ['ios/appstore/1.2.3/0123'],
  );
  assert.equal(rowsForBuild(preview.tags, 'abc').length, 0);
});

test('previewReading says what was read, and why a name is not used', () => {
  const preview = previewConventions(
    names(['android/playstore/1.2.3/9', 'catalyst/appstore/1.2.3/9', 'nope']),
    empty,
    'ios',
  );
  assert.match(
    previewReading(preview.tags[0] as never),
    /build 9 · version 1.2.3 · Android · playstore · other platform: not used for this app/,
  );
  assert.match(previewReading(preview.tags[1] as never), /platform catalyst \(not used\)/);
  assert.equal(previewReading(preview.tags[2] as never), 'Fits no pattern');
});

test('the draft is read line by line, and problems are the ones the server would give', () => {
  assert.deepEqual(parsePatternLines('  a-{buildNumber} \r\n\n b-{buildNumber}\n'), [
    'a-{buildNumber}',
    'b-{buildNumber}',
  ]);
  const ok = draftProblems({ ...empty, tagText: 'rel-{buildNumber}', workflow: 'release.yml' });
  assert.equal(hasDraftProblems(ok), false);
  assert.equal(hasDraftProblems(draftProblems(empty)), false, 'empty means the defaults');
  const bad = draftProblems({
    tagText: 'v{version}\nrel-{buildNumber}-{nope}',
    releaseText: '**{buildNumber}',
    prefix: 'a b',
    workflow: '../x',
  });
  assert.match(bad.tags.join(' '), /buildNumber/);
  assert.equal(bad.tags.length >= 2, true);
  assert.equal(bad.releases.length > 0, true);
  assert.ok(bad.prefix);
  assert.ok(bad.workflow);
  assert.equal(hasDraftProblems(bad), true);
  const many = draftProblems({
    ...empty,
    tagText: Array.from({ length: MAX_PATTERNS + 1 }, (_, i) => `t${i}-{buildNumber}`).join('\n'),
  });
  assert.equal(many.tags.length > 0, true);
});

test('draftOf and draftValues round-trip a stored convention, and sameDraft ignores spacing', () => {
  const view = {
    stored: {
      appId: null,
      tagPatterns: ['a-{buildNumber}'],
      releasePatterns: [],
      prefix: 'x-',
      workflow: 'release.yml',
      updatedBy: 'u',
      updatedAt: 1,
    },
  };
  const draft = draftOf(view);
  assert.deepEqual(draftValues(draft), {
    tagPatterns: ['a-{buildNumber}'],
    releasePatterns: [],
    prefix: 'x-',
    workflow: 'release.yml',
  });
  assert.deepEqual(draftOf({ stored: null }), empty);
  assert.deepEqual(draftValues(empty), {
    tagPatterns: [],
    releasePatterns: [],
    prefix: '',
    workflow: null,
  });
  assert.equal(
    sameDraft(draft, { ...draft, tagText: '  a-{buildNumber}\n\n', prefix: ' x- ' }),
    true,
  );
  assert.equal(sameDraft(draft, { ...draft, workflow: '' }), false);
});

test('the add-pattern helper proposes from one example, using the number and version of the build', () => {
  const build = { buildNumber: '123', version: '1.2.3' };
  const tag = proposeFromExample('ios/appstore/1.2.3/123', build, 'tag');
  assert.deepEqual(tag, { ok: true, pattern: '{platform}/{flavor}/{version}/{buildNumber}' });
  const dashes = proposeFromExample('app-1.2.3-123', build, 'tag');
  assert.equal(dashes.ok, true);
  const release = proposeFromExample('Weather(ios): v1.2.3 Build 123', build, 'release');
  assert.equal(release.ok, true);
  // The number of the build is found even when another number sits later in the name.
  const odd = proposeFromExample(
    'release-123-2024',
    { buildNumber: '123', version: '9.9.9' },
    'tag',
  );
  assert.equal(odd.ok && odd.pattern.includes('{buildNumber}'), true);
  assert.deepEqual(proposeFromExample('', build, 'tag'), {
    ok: false,
    message: 'Paste or pick a tag or release name.',
  });
  assert.deepEqual(proposeFromExample('nightly', build, 'tag'), {
    ok: false,
    message: 'No build number was found in that name.',
  });
});

test('a proposed pattern reads the example back through the preview', () => {
  const example = 'ios/appstore/1.2.3/123';
  const proposal = proposeFromExample(example, { buildNumber: '123', version: '1.2.3' }, 'tag');
  assert.ok(proposal.ok);
  const preview = previewConventions(
    names([example]),
    { ...empty, tagText: proposal.ok ? proposal.pattern : '' },
    'ios',
  );
  assert.equal(preview.tags[0]?.fields?.buildNumber, '123');
  assert.equal(rowsForBuild(preview.tags, '123').length, 1);
});

test('appendPattern adds once, keeps the defaults when the list was empty, and respects the limit', () => {
  const defaults = ['d1-{buildNumber}', 'd2-{buildNumber}'];
  assert.deepEqual(appendPattern('', 'new-{buildNumber}', defaults), {
    text: 'new-{buildNumber}\nd1-{buildNumber}\nd2-{buildNumber}',
    added: true,
  });
  assert.deepEqual(appendPattern('a-{buildNumber}', 'b-{buildNumber}', defaults), {
    text: 'a-{buildNumber}\nb-{buildNumber}',
    added: true,
  });
  const twice = appendPattern('a-{buildNumber}', 'a-{buildNumber}');
  assert.equal(twice.added, false);
  assert.match(twice.reason ?? '', /already/);
  const full = Array.from({ length: MAX_PATTERNS }, (_, i) => `p${i}-{buildNumber}`).join('\n');
  const refused = appendPattern(full, 'x-{buildNumber}');
  assert.equal(refused.added, false);
  assert.equal(refused.text, full);
  assert.match(refused.reason ?? '', /20 patterns/);
  assert.equal(
    appendPattern(
      '',
      'x-{buildNumber}',
      Array.from({ length: 30 }, (_, i) => `d${i}`),
    ).text.split('\n').length,
    MAX_PATTERNS,
  );
});

test('the confidence is said in words, and only a low guess is flagged', () => {
  assert.deepEqual(confidenceBadge('high'), { label: 'High confidence', tone: 'ok' });
  assert.equal(confidenceBadge('medium').label, 'Medium confidence');
  assert.deepEqual(confidenceBadge('low'), { label: 'Low confidence', tone: 'warn' });
  assert.equal(isUncertain({ confidence: 'low', manual: false }), true);
  assert.equal(isUncertain({ confidence: 'low', manual: true }), false);
  assert.equal(isUncertain({ confidence: 'medium', manual: false }), false);
  assert.equal(isUncertain(null), false);
});

test('"Tag found" names the tag and what is missing', () => {
  assert.match(tagFoundText({ evidence: null }), /no run was found/);
  assert.equal(
    tagFoundText({
      evidence: {
        tag: 'ios/appstore/1.2.3/123',
        kind: 'tag',
        noRunReason: 'No stored run has this commit.',
      },
    }),
    'The tag ios/appstore/1.2.3/123 carries this build number. No stored run has this commit.',
  );
  assert.match(
    tagFoundText({ evidence: { tag: 'v1', kind: 'release', noRunReason: null } }),
    /^The GitHub release v1 carries/,
  );
});

test('diagnosticsLines tell what was searched, and what failed', () => {
  assert.deepEqual(
    diagnosticsLines(diagnostics({ scannedAt: null, scanOk: null, tags: null, releases: null })),
    ['Tags and releases have not been searched yet.', '3 CI runs are stored.'],
  );
  assert.match(
    diagnosticsLines(diagnostics({ scanOk: false, scanError: 'GitHub refused' }))[0] ?? '',
    /failed: GitHub refused/,
  );
  const lines = diagnosticsLines(
    diagnostics({ fitting: 2, newestFit: { name: 'ios/appstore/1.2.3/120', buildNumber: '120' } }),
  );
  assert.equal(lines[0], '5 tags read.');
  assert.equal(lines[1], '2 GitHub releases read.');
  assert.match(
    lines[2] ?? '',
    /newest build number among them is 120 \(ios\/appstore\/1.2.3\/120\)/,
  );
  assert.match(diagnosticsLines(diagnostics())[2] ?? '', /No tag or release name fits a pattern/);
  assert.match(
    diagnosticsLines(
      diagnostics({ tags: { seen: 100, truncated: true, sample: [], targeted: [] } }),
    )[0] ?? '',
    /more exist than were read/,
  );
  assert.match(
    diagnosticsLines(
      diagnostics({ releases: { seen: 0, truncated: false, error: 'forbidden' } }),
    )[1] ?? '',
    /Releases could not be read: forbidden/,
  );
  assert.equal(
    diagnosticsLines(diagnostics({ runs: { stored: 1, newestAt: 1 } })).at(-1),
    '1 CI run is stored.',
  );
});

test('conventionSourceLabel names where the patterns come from', () => {
  assert.equal(conventionSourceLabel({ source: 'app' }), "this app's own patterns");
  assert.equal(conventionSourceLabel({ source: 'repository' }), "the repository's patterns");
  assert.equal(conventionSourceLabel({ source: 'defaults' }), 'the built-in patterns');
});

test('the page searches by itself only once, for a person who may, when nothing was searched', () => {
  const base = {
    hasRepository: true,
    canScan: true,
    diagnostics: { scannedAt: null, canReadTags: true },
    unlinked: 2,
    alreadyTried: false,
  };
  assert.equal(shouldAutoRematch(base), true);
  assert.equal(shouldAutoRematch({ ...base, canScan: false }), false, 'a viewer cannot ask GitHub');
  assert.equal(shouldAutoRematch({ ...base, hasRepository: false }), false);
  assert.equal(shouldAutoRematch({ ...base, unlinked: 0 }), false);
  assert.equal(shouldAutoRematch({ ...base, alreadyTried: true }), false);
  assert.equal(
    shouldAutoRematch({ ...base, diagnostics: { scannedAt: 5, canReadTags: true } }),
    false,
  );
  assert.equal(
    shouldAutoRematch({ ...base, diagnostics: { scannedAt: null, canReadTags: false } }),
    false,
  );
  assert.equal(shouldAutoRematch({ ...base, diagnostics: null }), false);
});
