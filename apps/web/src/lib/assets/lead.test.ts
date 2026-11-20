import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetProblem } from '@mrm/core';
import { affectedSets, assetsLead, otherCountsText, problemAction, splitProblems } from './lead.ts';

const p = (over: Partial<AssetProblem>): AssetProblem => ({
  rule: 'apple.screenshot.size',
  severity: 'error',
  message: 'm',
  source: 'https://example.com',
  verified: true,
  ...over,
});

test('splitProblems: errors block, the rest folds', () => {
  const s = splitProblems([p({}), p({ severity: 'warning' }), p({ severity: 'info' })]);
  assert.equal(s.blocking.length, 1);
  assert.equal(s.other.length, 2);
  assert.equal(otherCountsText(s.other), '1 warning, 1 note');
  assert.equal(otherCountsText([]), '');
});

test('affectedSets counts a set once however many files fail in it, and names a single kind', () => {
  const a = affectedSets([
    p({ path: 'a.png', locale: 'en-US', kind: 'screenshot', device: 'iphone' }),
    p({ path: 'b.png', locale: 'en-US', kind: 'screenshot', device: 'iphone' }),
    p({ path: 'c.png', locale: 'de-DE', kind: 'screenshot', device: 'iphone' }),
  ]);
  assert.deepEqual(a, { count: 2, kind: 'screenshot' });
  assert.deepEqual(
    affectedSets([
      p({ locale: 'en-US', kind: 'icon' }),
      p({ locale: 'en-US', kind: 'screenshot' }),
    ]),
    { count: 2, kind: null },
  );
  assert.deepEqual(affectedSets([p({})]), { count: 1, kind: null });
});

test('assetsLead: blocking first, then warnings, then all good', () => {
  const bad = assetsLead({
    summary: '9 files',
    problems: [
      p({ locale: 'en-US', kind: 'screenshot', device: 'iphone' }),
      p({ locale: 'de-DE', kind: 'screenshot', device: 'iphone' }),
      p({ severity: 'warning', locale: 'fr-FR', kind: 'screenshot' }),
    ],
  });
  assert.equal(bad.headline, '2 screenshot sets have problems');
  assert.equal(bad.tone, 'bad');
  assert.equal(bad.blocking, 2);
  assert.equal(
    assetsLead({ summary: 's', problems: [p({ locale: 'en-US', kind: 'icon' })] }).headline,
    '1 icon set has a problem',
  );
  const warn = assetsLead({
    summary: 's',
    problems: [
      p({ severity: 'warning', locale: 'en-US', kind: 'screenshot' }),
      p({ severity: 'info' }),
    ],
  });
  assert.equal(warn.headline, '1 screenshot set has a warning');
  assert.equal(warn.tone, 'warn');
  const ok = assetsLead({ summary: '3 files', problems: [p({ severity: 'info' })] });
  assert.equal(ok.headline, 'All files pass the store checks');
  assert.equal(ok.tone, 'ok');
});

test('problemAction: one sentence by the end of the rule, nothing for an unknown one', () => {
  assert.match(problemAction('apple.screenshot.size'), /accepted size/);
  assert.match(problemAction('play.icon.bytes'), /smaller/);
  assert.match(problemAction('play.icon.format'), /format/);
  assert.match(problemAction('apple.screenshot.count'), /limit/);
  assert.match(problemAction('play.screenshot.minimum'), /Add more/);
  assert.equal(problemAction('something.else'), '');
});
