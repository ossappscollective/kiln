import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compilePattern,
  compilePatterns,
  DEFAULT_RELEASE_PATTERNS,
  DEFAULT_TAG_PATTERNS,
  MAX_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS,
  matchName,
  patternListProblems,
  platformFromWord,
  previewPatterns,
  proposePattern,
} from './build-patterns.ts';

const read = (pattern: string, name: string, prefix = '') => {
  const done = compilePattern(pattern, { prefix });
  assert.ok(done.ok, done.ok ? '' : done.error);
  return done.compiled.test(name);
};

test('the maintainer layout: {platform}/{flavor}/{version}/{buildNumber}', () => {
  const p = '{prefix}{platform}/{flavor}/{version}/{buildNumber}';
  assert.deepEqual(read(p, 'ios/appstore/1.4.0/312'), {
    platformWord: 'ios',
    platform: 'ios',
    flavor: 'appstore',
    version: '1.4.0',
    buildNumber: '312',
  });
  assert.equal(read(p, 'android/playstore/1.4.0/312')?.platform, 'android');
  assert.equal(read(p, 'android/github/2.0.0-beta.1/7')?.version, '2.0.0-beta.1');
  assert.equal(read(p, 'catalyst/production/1.4.0/312')?.platform, 'other');
  // Anchored: nothing before or after, and the number is the whole last segment.
  assert.equal(read(p, 'x/ios/appstore/1.4.0/312'), undefined);
  assert.equal(read(p, 'ios/appstore/1.4.0/312/extra'), undefined);
  assert.equal(read(p, 'ios/appstore/1.4.0/312a'), undefined);
  assert.equal(read(p, 'ios/appstore/1.4.0/12345678901'), undefined, 'at most ten digits');
  assert.equal(read(p, 'ios/appstore/1.4.0/'), undefined);
  assert.equal(read(p, ''), undefined);
});

test('{prefix} is the literal TAG_PREFIX of an app, and escaped', () => {
  const p = '{prefix}{platform}/{flavor}/{version}/{buildNumber}';
  assert.equal(read(p, 'scanner-ios/appstore/1.4.0/312', 'scanner-')?.buildNumber, '312');
  assert.equal(
    read(p, 'wallet-ios/appstore/1.4.0/312', 'scanner-'),
    undefined,
    'another app prefix does not fit',
  );
  assert.equal(read(p, 'ios/appstore/1.4.0/312', 'scanner-'), undefined);
  // A prefix with regex characters is only text.
  assert.equal(read(p, 'a.b/ios/x/1.0.0/1', 'a.b/')?.platform, 'ios');
  assert.equal(read(p, 'axb/ios/x/1.0.0/1', 'a.b/'), undefined);
  assert.equal(compilePattern(p, { prefix: '(a+)+$' }).ok, false);
  assert.equal(compilePattern(p, { prefix: 'x'.repeat(41) }).ok, false);
});

test('the other built-in tag conventions', () => {
  const tag = (name: string) => matchName(name, compilePatterns(DEFAULT_TAG_PATTERNS));
  assert.deepEqual(tag('v1.4.0+312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('1.4.0+312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('1.4.0-312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('v1.4.0-312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('1.4.0(312)')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('v1.4.0(312)')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('build-312')?.fields, { buildNumber: '312' });
  assert.deepEqual(tag('release/1.4.0/312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(tag('ios-1.4.0-312')?.fields, {
    platformWord: 'ios',
    platform: 'ios',
    version: '1.4.0',
    buildNumber: '312',
  });
  assert.equal(tag('android/1.4.0/312')?.fields.platform, 'android');
  assert.equal(tag('1.4.0-beta.1-312')?.fields.version, '1.4.0-beta.1');
  assert.equal(tag('1.4.0-beta.1-312')?.fields.buildNumber, '312');
  // Not build tags.
  for (const name of [
    'v1.4.0',
    'latest',
    'nightly',
    'v1.4.0-beta.1',
    'ios/appstore/1.4.0',
    'build-',
    'build-x1',
  ]) {
    assert.equal(tag(name), undefined, name);
  }
});

test('release names: "<app>(<platform>): v<version> Build <n>" and common variants', () => {
  const rel = (name: string) =>
    matchName(name, compilePatterns(DEFAULT_RELEASE_PATTERNS, { kind: 'release' }));
  assert.deepEqual(rel('Trail Notes(ios): v1.4.0 Build 312')?.fields, {
    platformWord: 'ios',
    platform: 'ios',
    version: '1.4.0',
    buildNumber: '312',
  });
  assert.equal(rel('Trail Notes(android): v1.4.0 Build 312')?.fields.platform, 'android');
  assert.deepEqual(rel('Trail Notes: v1.4.0 Build 312')?.fields, {
    version: '1.4.0',
    buildNumber: '312',
  });
  assert.deepEqual(rel('v1.4.0 Build 312')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.deepEqual(rel('Trail Notes 1.4.0 (build 312)')?.fields, {
    version: '1.4.0',
    buildNumber: '312',
  });
  assert.deepEqual(rel('Release v1.4.0 (312)')?.fields, { version: '1.4.0', buildNumber: '312' });
  assert.equal(rel('Build 312')?.fields.buildNumber, '312');
  assert.equal(rel('Trail Notes(ios): v1.4.0 Build 3120')?.fields.buildNumber, '3120');
  assert.equal(rel('Trail Notes v1.4.0'), undefined);
  assert.equal(rel('Weekly notes'), undefined);
});

test('matching ignores case, and a tag pattern refuses spaces', () => {
  assert.equal(
    read('{platform}/{flavor}/{version}/{buildNumber}', 'iOS/AppStore/1.4.0/312')?.platform,
    'ios',
  );
  assert.equal(compilePattern('build {buildNumber}', { kind: 'tag' }).ok, false);
  assert.equal(compilePattern('build {buildNumber}', { kind: 'release' }).ok, true);
});

test('platform words', () => {
  assert.equal(platformFromWord('iOS'), 'ios');
  assert.equal(platformFromWord('iphone'), 'ios');
  assert.equal(platformFromWord('ANDROID'), 'android');
  assert.equal(platformFromWord('playstore'), 'other');
  assert.equal(platformFromWord('catalyst'), 'other');
});

test('a pattern needs {buildNumber} and only known placeholders, each once', () => {
  const problem = (p: string, kind: 'tag' | 'release' = 'tag') => {
    const done = compilePattern(p, { kind });
    return done.ok ? undefined : done.error;
  };
  assert.match(problem('v{version}') ?? '', /needs \{buildNumber\}/);
  assert.match(problem('{buildNumber}-{buildNumber}') ?? '', /once/);
  assert.match(problem('{version}-{build}') ?? '', /not a placeholder/);
  assert.match(problem('{buildNumber') ?? '', /no closing/);
  assert.match(problem('build}-{buildNumber}') ?? '', /no opening/);
  assert.match(problem('') ?? '', /empty/);
  assert.match(problem('a\u0000{buildNumber}') ?? '', /control/);
  assert.match(problem('{prefix}{prefix}{buildNumber}') ?? '', /once/);
});

test('a pattern cannot be made expensive: length, wildcards, and bounded parts', () => {
  const long = `${'a'.repeat(MAX_PATTERN_LENGTH)}{buildNumber}`;
  assert.match(patternListProblems([long]).join(), /too long/);
  assert.equal(compilePattern('*{buildNumber}', { kind: 'release' }).ok, true);
  assert.equal(compilePattern('**{buildNumber}', { kind: 'release' }).ok, false);
  assert.equal(
    compilePattern('*a*b*{buildNumber}', { kind: 'release' }).ok,
    false,
    'three wildcards',
  );
  assert.equal(compilePattern('*{version}*{buildNumber}', { kind: 'release' }).ok, true);
  // Regex syntax in a pattern is only text.
  const evil = compilePattern('(a+)+$.*{buildNumber}', { kind: 'tag' });
  assert.ok(evil.ok);
  assert.equal(evil.compiled.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'), undefined);
  assert.equal(evil.compiled.test('(a+)+$.*7')?.buildNumber, '7');
  assert.equal(evil.compiled.test('aaaa7'), undefined);
  assert.equal(read('[a-z]+{buildNumber}', 'abc7'), undefined);
});

test('the worst case is fast: wildcards against a long near-miss name', () => {
  const name = `${'a'.repeat(MAX_NAME_LENGTH - 2)}Z!`;
  const compiled = compilePatterns(
    ['*a*{version}{buildNumber}x', '*{flavor}*{buildNumber}x', '*a*a{buildNumber}'],
    { kind: 'release' },
  );
  assert.equal(compiled.length, 3);
  const started = Date.now();
  for (let i = 0; i < 200; i++) for (const c of compiled) c.test(name);
  assert.ok(Date.now() - started < 3000, 'bounded work for every name');
  // A name over the limit is never tested.
  const long = compilePattern('*{buildNumber}', { kind: 'release' });
  assert.ok(long.ok);
  assert.equal(long.compiled.test(`${'a'.repeat(MAX_NAME_LENGTH)}7`), undefined);
  assert.equal(long.compiled.test(`${'a'.repeat(70)}7`)?.buildNumber, '7');
});

test('a list: at most MAX_PATTERNS, no duplicates, each problem numbered', () => {
  assert.deepEqual(patternListProblems(['{buildNumber}', 'v{version}+{buildNumber}']), []);
  assert.match(patternListProblems(['{buildNumber}', 'oops']).join(), /Pattern 2: .*needs/);
  assert.match(
    patternListProblems(['{buildNumber}', '{buildNumber}']).join(),
    /Pattern 2: listed twice/,
  );
  const many = Array.from({ length: MAX_PATTERNS + 1 }, (_, i) => `t${i}-{buildNumber}`);
  assert.match(patternListProblems(many).join(), /At most/);
  assert.equal(compilePatterns(many).length, MAX_PATTERNS);
});

test('the defaults are all valid', () => {
  assert.deepEqual(patternListProblems(DEFAULT_TAG_PATTERNS), []);
  assert.deepEqual(patternListProblems(DEFAULT_RELEASE_PATTERNS, { kind: 'release' }), []);
});

test('previewPatterns: what each name gives, and whether the platform fits', () => {
  const rows = previewPatterns(
    ['ios/appstore/1.4.0/312', 'android/playstore/1.4.0/312', 'v1.4.0', 'build-9'],
    ['{platform}/{flavor}/{version}/{buildNumber}', 'build-{buildNumber}'],
    { platform: 'ios' },
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.matched, r.fields?.buildNumber, r.platformOk]),
    [
      ['ios/appstore/1.4.0/312', true, '312', true],
      ['android/playstore/1.4.0/312', true, '312', false],
      ['v1.4.0', false, undefined, undefined],
      ['build-9', true, '9', undefined],
    ],
  );
  // An invalid pattern is skipped, not fatal.
  assert.equal(previewPatterns(['a-1'], ['nope', 'a-{buildNumber}'])[0]?.matched, true);
});

test('proposePattern builds a pattern from an example tag', () => {
  const p = (name: string, hints = {}) => proposePattern(name, hints)?.pattern;
  assert.equal(p('ios/appstore/1.4.0/312'), '{platform}/{flavor}/{version}/{buildNumber}');
  assert.equal(
    p('android/playstore/1.4.0/312', { buildNumber: '312' }),
    '{platform}/{flavor}/{version}/{buildNumber}',
  );
  assert.equal(p('v1.4.0+312'), 'v{version}+{buildNumber}');
  assert.equal(p('1.4.0(312)'), '{version}({buildNumber})');
  assert.equal(p('build-312'), 'build-{buildNumber}');
  assert.equal(p('release/1.4.0/312'), 'release/{version}/{buildNumber}');
  assert.equal(
    p('scanner-ios/appstore/1.4.0/312'),
    'scanner-{platform}/{flavor}/{version}/{buildNumber}',
  );
  assert.equal(p('ios-1.4.0-312'), '{platform}-{version}-{buildNumber}');
  // The hinted number wins over "the last number".
  assert.equal(
    p('ios/1.4.0/312/7', { buildNumber: '312' }),
    '{platform}/{version}/{buildNumber}/7',
  );
  assert.equal(
    p('ios/1.4.0/312/7'),
    '{platform}/{version}/312/{buildNumber}',
    'otherwise the last number',
  );
  assert.equal(p('latest'), undefined);
  assert.equal(proposePattern(`${'x'.repeat(MAX_NAME_LENGTH)}1`), undefined);
});

test('a proposal reads its own example back, also when the example has regex characters', () => {
  for (const name of [
    'ios/appstore/1.4.0/312',
    'v1.4.0+312',
    'a.b(c)/ios/1.2.3/45',
    'x[1]-ios-1.2.3-4',
  ]) {
    const proposal = proposePattern(name);
    assert.ok(proposal, name);
    const again = compilePattern(proposal.pattern);
    assert.ok(again.ok && again.compiled.test(name), name);
  }
});

test('proposePattern for a release name keeps the free text', () => {
  const p = proposePattern('Trail Notes(ios): v1.4.0 Build 312', {
    kind: 'release',
    buildNumber: '312',
    version: '1.4.0',
  });
  assert.ok(p);
  assert.equal(p.pattern, 'Trail Notes({platform}): v{version} Build {buildNumber}');
  assert.equal(p.fields.platform, 'ios');
});

test('macos, mac and osx name the macOS platform; other words stay other', () => {
  assert.equal(platformFromWord('macos'), 'macos');
  assert.equal(platformFromWord('MacOS'), 'macos');
  assert.equal(platformFromWord('mac'), 'macos');
  assert.equal(platformFromWord('osx'), 'macos');
  assert.equal(platformFromWord('catalyst'), 'other');
  assert.equal(platformFromWord('tvos'), 'other');
  assert.equal(platformFromWord('iphone'), 'ios');
});

test('a tag or release name with the platform word macos is read and matched for a macOS app', () => {
  const tag = read('{prefix}{platform}/{version}/{buildNumber}', 'macos/2.1.0/45');
  assert.equal(tag?.platform, 'macos');
  assert.equal(tag?.version, '2.1.0');
  assert.equal(tag?.buildNumber, '45');
  const osx = read('{prefix}{platform}-{version}-{buildNumber}', 'osx-2.1.0-45');
  assert.equal(osx?.platform, 'macos');
  const done = compilePattern('*({platform}): v{version} Build {buildNumber}', { kind: 'release' });
  assert.ok(done.ok);
  assert.equal(
    done.ok ? done.compiled.test('Trail Notes(mac): v2.1.0 Build 45')?.platform : undefined,
    'macos',
  );
  const rows = previewPatterns(
    ['macos/2.1.0/45', 'ios/2.1.0/312'],
    ['{prefix}{platform}/{version}/{buildNumber}'],
    { platform: 'macos' },
  );
  assert.deepEqual(
    rows.map((r) => r.platformOk),
    [true, false],
  );
});

test('a repository tag is proposed with {platform} when it says macos', () => {
  const proposed = proposePattern('macos/2.1.0/45', { version: '2.1.0', buildNumber: '45' });
  assert.ok(proposed?.pattern.includes('{platform}'), proposed?.pattern);
});
