import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootAi, keywordAnswer } from './test-helpers.ts';

/**
 * Accepting keyword ideas (bug: "it said they were added but I do not see them"). The server side of the answer to it: an accept
 * tracks the ticked ideas for the right app, platform and market (tag `ai`) and says where, and ticking only some leaves the
 * rest PROPOSED instead of closing the suggestion on the first accept.
 */
const prepare = async (db: Parameters<typeof bootAi>[0], platform: 'ios' | 'android' = 'ios') => {
  const answer = keywordAnswer([
    'water reminder app',
    'hydration tracker',
    'drink log',
    'sip timer',
  ]);
  if (platform === 'android')
    for (const idea of (answer.output as { ideas: { field: string }[] }).ideas)
      idea.field = 'title';
  const t = await bootAi(db, { answers: [answer] });
  await t.ready();
  const appId = await t.addApp(platform);
  await t.seedListing(
    appId,
    platform,
    'en-US',
    platform === 'android'
      ? {
          title: 'Aqua',
          short_description: 'Drink more',
          full_description: 'A friendly water reminder.',
        }
      : undefined,
  );
  const res = await t.run('keyword_ideas', { appId, locale: 'en-US', country: 'us' });
  assert.equal(res.status, 201, res.text);
  return { t, appId, id: res.body.suggestion.id as string };
};

for (const platform of ['ios', 'android'] as const) {
  dbTest(
    `keyword ideas (${platform}): accepted ideas are tracked for that app, market and platform with the ai tag, and the result says where`,
    async (db) => {
      const { t, appId, id } = await prepare(db, platform);
      const accepted = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, {
        items: [0, 1, 2, 3],
      });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.body.suggestion.status, 'accepted');
      assert.equal(accepted.body.result.created, 4);
      assert.equal(accepted.body.result.locale, 'en-US');
      assert.equal(accepted.body.result.country, 'us');
      assert.equal(accepted.body.result.remaining, 0);
      const list = await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`);
      assert.equal(list.body.keywords.length, 4);
      for (const k of list.body.keywords) {
        assert.equal(k.tag, 'ai');
        assert.equal(k.platform, platform);
        assert.equal(k.locale, 'en-US');
        assert.equal(k.country, 'us');
      }
    },
  );
}

dbTest(
  'keyword ideas: ticking only some tracks them and leaves the others proposed; the last one closes the suggestion',
  async (db) => {
    const { t, appId, id } = await prepare(db);
    const first = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, { items: [0, 2] });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.result.created, 2);
    assert.equal(first.body.result.remaining, 2);
    assert.equal(first.body.suggestion.status, 'proposed', 'two ideas are still open');
    const shown = first.body.suggestion.proposal.items as {
      term: string;
      acceptable: boolean;
      flags: string[];
    }[];
    assert.deepEqual(
      shown.map((i) => i.acceptable),
      [false, true, false, true],
    );
    assert.ok(shown[0]?.flags.includes('already_tracked'));
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/ai/suggestions?status=proposed`)).body
        .suggestions.length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords.length,
      2,
    );

    // An item taken already cannot be taken again; the rest can.
    const again = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, { items: [0] });
    assert.equal(again.status, 422);
    assert.equal(again.body.error, 'nothing_acceptable');

    const second = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, { items: [1] });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.result.remaining, 1);
    assert.equal(second.body.suggestion.status, 'proposed');
    const last = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`);
    assert.equal(last.status, 200, last.text);
    assert.equal(last.body.result.created, 1);
    assert.equal(last.body.result.remaining, 0);
    assert.equal(last.body.suggestion.status, 'accepted');
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords.length,
      4,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`)).body.error,
      'suggestion_not_proposed',
    );
    const actions = (await t.auditActions()).map((a) => a.action);
    assert.equal(actions.filter((a) => a === 'ai.suggestion_accepted').length, 3);
  },
);

dbTest(
  'keyword ideas: a partly accepted suggestion can still be dismissed, and dismissing creates nothing more',
  async (db) => {
    const { t, appId, id } = await prepare(db);
    assert.equal(
      (await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, { items: [0] })).status,
      200,
    );
    const done = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/dismiss`);
    assert.equal(done.status, 200);
    assert.equal(done.body.suggestion.status, 'dismissed');
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords.length,
      1,
    );
  },
);

dbTest(
  'keyword ideas: an idea the app tracked meanwhile counts as already tracked, not as added',
  async (db) => {
    const { t, appId, id } = await prepare(db);
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
      keywords: [{ term: 'Sip Timer', country: 'us', locale: 'en-US' }],
    });
    const res = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, { items: [3] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.result.created, 0);
    assert.equal(res.body.result.existing, 1);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords.length,
      1,
    );
  },
);
