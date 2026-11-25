import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTerm } from './aso/aso.ts';
import { buildCoach } from './aso/aso-coach.ts';
import { checkPlayProposal } from './release/play-release-checks.ts';
import { compareRollout, ROLLOUT_TEMPLATES, validateRolloutSteps } from './release/rollout-plan.ts';
import { coreText } from './text.ts';

const KEY = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

test('coreText: a key and parameters', () => {
  assert.deepEqual(coreText('a.b', { n: 2 }), { key: 'a.b', params: { n: 2 } });
  assert.deepEqual(coreText('a.b'), { key: 'a.b', params: {} });
});

test('the keys next to core sentences are camelCase ids with plain parameters', () => {
  const texts = [
    ...ROLLOUT_TEMPLATES.flatMap((t) => [t.nameText, t.descriptionText]),
    compareRollout([], null).text,
    ...(() => {
      const r = validateRolloutSteps([{ percent: 0 }], { planCreatedAt: 0 });
      return r.ok ? [] : r.issues.map((i) => i.text);
    })(),
    ...buildCoach({
      platform: 'ios',
      now: 1,
      keywords: [],
      competitors: [],
      competitorsAbove: [],
      listingLocales: [],
      lastCheckAt: null,
      rankMoveThreshold: 3,
    }).flatMap((a) => [a.titleText, a.detailText, a.linkText]),
    ...checkPlayProposal(
      { track: '', releaseName: '', versionCodes: [], notes: [], userFraction: null },
      { listingLocales: [], trackReleases: [] },
    ).map((c) => c.text),
  ];
  const bad = checkTerm('');
  if (!bad.ok) texts.push(bad.text);
  assert.ok(texts.length > 8);
  for (const text of texts) {
    assert.match(text.key, KEY);
    for (const v of Object.values(text.params))
      assert.ok(typeof v === 'string' || typeof v === 'number');
  }
});
