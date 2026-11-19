import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStrictCompatible } from '@mrm/connectors';
import { findBannedWord, normalizeAiAppContext } from '@mrm/core';
import { dbTest } from '@mrm/db/testing';
import { type AiBoot, bootAi } from './ai-test-helpers.ts';
import { keywordIdeasFromReviewsTask } from './services/ai-task-aso.ts';
import { redactPersonal } from './services/ai-task-data.ts';
import { claimsUnknownRank, oneOf, strings } from './services/ai-task-lenient.ts';
import { aiTasks } from './services/ai-tasks.ts';
import { usageWarning } from './services/ai-usage.ts';

/**
 * The AI features of docs/adr/0024-ai-features.md: review summary, review tags (cached), fix next, listing audit, the ASO health
 * report, keyword ideas from reviews, text variants, translation, the per-app AI context, the preview and the soft cost warning.
 * The model is a scripted fake: nothing leaves the process. The theme is the same as the foundation's: a model PROPOSES, the server
 * counts and checks, and a sloppy answer from a small model is read leniently instead of thrown away.
 */

const DAY = 86_400_000;
const RECENT = Date.UTC(2026, 10, 10);

const ios = async (t: AiBoot, locale = 'en-US', fields?: Record<string, string>) => {
  const appId = await t.addApp('ios');
  await t.seedListing(appId, 'ios', locale, fields);
  return appId;
};

type Seed = {
  rating?: number;
  title?: string;
  author?: string;
  version?: string | null;
  language?: string;
  daysAgo?: number;
  response?: boolean;
};
let seq = 0;
/** A review made recent enough to be in a 30 day period, with an app version. */
async function review(t: AiBoot, appId: string, body: string, over: Seed = {}): Promise<string> {
  const id = await t.seedReview(appId, body, {
    ...(over.rating !== undefined ? { rating: over.rating } : {}),
    ...(over.title !== undefined ? { title: over.title } : {}),
    ...(over.author !== undefined ? { author: over.author } : {}),
    ...(over.language !== undefined ? { language: over.language } : {}),
  });
  await t.db.execute(
    'UPDATE app_reviews SET created_at = ?, app_version = ?, developer_response = ? WHERE id = ?',
    [
      // The reviews of one test are newest first in the order they are made, so r1 is the first one made.
      RECENT - (over.daysAgo ?? 0) * DAY - (seq += 1) * 1000,
      over.version === undefined ? '2.0' : over.version,
      over.response ? JSON.stringify({ body: 'Thanks', at: 1, state: 'PUBLISHED' }) : null,
      id,
    ],
  );
  return id;
}

const usage = { inputTokens: 900, outputTokens: 300 };

// ----- the per-app AI context ---------------------------------------------------------------------------

dbTest(
  'the AI context of an app: edited by admins, validated, audited without its text, and sent only when filled in',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');

    const empty = await t.call(t.owner, 'GET', `/apps/${appId}/ai/context`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.updatedAt, null);
    assert.equal(empty.body.canEdit, true);
    assert.equal((await t.call(member, 'GET', `/apps/${appId}/ai/context`)).body.canEdit, false);
    assert.equal(
      (await t.call(viewer, 'GET', `/apps/${appId}/ai/context`)).status,
      403,
      'reading it needs the right to use AI',
    );

    t.answer({ output: { ideas: [] }, usage });
    await t.run('keyword_ideas', { appId, locale: 'en-US' });
    assert.equal(
      'appContext' in (t.fake.calls[0]?.input as object),
      false,
      'an app without a context sends exactly what it sent before',
    );

    const put = {
      about: 'A water reminder.  \n',
      tone: 'warm, plain',
      bannedWords: ['Cheap', 'cheap', ' '],
      brandTerms: ['AquaPal'],
      dontList: ['Never use exclamation marks'],
    };
    assert.equal(
      (await t.call(member, 'PUT', `/apps/${appId}/ai/context`, put)).status,
      403,
      'changing it needs the right to change the app',
    );
    const saved = await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, put);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.context, {
      about: 'A water reminder.',
      audience: '',
      tone: 'warm, plain',
      brandVoice: '',
      bannedWords: ['Cheap'],
      brandTerms: ['AquaPal'],
      doList: [],
      dontList: ['Never use exclamation marks'],
    });
    assert.ok(saved.body.updatedAt > 0);

    const tooLong = await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, {
      tone: 'x'.repeat(200),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.issues[0].path, 'tone');
    assert.equal(
      (await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, { surprise: 1 })).status,
      400,
      'unknown fields are refused',
    );

    const audit = await db.query(
      "SELECT detail FROM audit_events WHERE action = 'ai.app_context_update'",
    );
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(String(audit[0]?.detail)).fields.sort(), [
      'about',
      'bannedWords',
      'brandTerms',
      'dontList',
      'tone',
    ]);
    assert.ok(
      !String(audit[0]?.detail).includes('water reminder'),
      'the audit names the fields, never their text',
    );

    t.answer({
      output: {
        ideas: [
          { term: 'cheap water app', reason: 'Fine.', field: 'keywords' },
          { term: 'hydration log', reason: 'Fine.', field: 'keywords' },
        ],
      },
      usage,
    });
    const run = await t.run('keyword_ideas', { appId, locale: 'en-US' });
    assert.equal(run.status, 201, run.text);
    const sent = t.fake.calls[1]?.input as { appContext: Record<string, unknown> };
    assert.deepEqual(sent.appContext, {
      about: 'A water reminder.',
      tone: 'warm, plain',
      dont: ['Never use exclamation marks'],
      neverUseWords: ['Cheap'],
      keepExactlyAsWritten: ['AquaPal'],
    });
    const items = run.body.suggestion.proposal.items;
    assert.deepEqual(
      items[0].flags,
      ['banned_term'],
      'a banned word is flagged by the server, after the model',
    );
    assert.equal(items[0].acceptable, false);
    assert.equal(items[1].acceptable, true);

    // Deleting the app deletes its context.
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status < 300, true);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ai_app_context'))[0]?.n), 0);
  },
);

test('the AI context normalizer cleans text, drops repeats and refuses what is too long', () => {
  const ok = normalizeAiAppContext({ audience: ' busy  people ', doList: ['a', 'A', ''] });
  assert.ok(ok.ok && ok.value.audience === 'busy people' && ok.value.doList.length === 1);
  assert.equal(
    normalizeAiAppContext({ bannedWords: new Array(31).fill(0).map((_, i) => `w${i}`) }).ok,
    false,
  );
  assert.equal(normalizeAiAppContext({ nope: 1 }).ok, false);
  assert.equal(
    findBannedWord('A Cheapskate and a cheap one', ['cheap']),
    'cheap',
    'whole words only: Cheapskate alone would not match',
  );
  assert.equal(findBannedWord('Cheapskate only', ['cheap']), undefined);
});

// ----- review_summary ------------------------------------------------------------------------------------

dbTest(
  'review_summary: the model groups, the server counts, evidence is checked, and a small model answer is read leniently',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    const ids: string[] = [];
    ids.push(
      await review(t, appId, 'Crashes when I open it, mail me at pat@example.com please', {
        rating: 1,
        author: 'Pat Reviewer',
        title: 'Broken',
      }),
    );
    ids.push(
      await review(t, appId, 'Pat Reviewer here: still crashes after the update', {
        rating: 2,
        author: 'Pat Reviewer',
      }),
    );
    ids.push(await review(t, appId, 'Love the reminders', { rating: 5 }));
    ids.push(await review(t, appId, 'Great, would like a widget', { rating: 4 }));
    ids.push(await review(t, appId, 'It is fine', { rating: 3 }));
    await review(t, appId, 'Ancient review', { rating: 1, daysAgo: 90 });

    t.answer({
      output: {
        overview: 'Mostly happy. Crashes are the main problem.',
        themes: [
          {
            label: 'Crashes on launch',
            kind: 'Bug',
            summary: 'The app crashes.',
            refs: ['r1', 'R2', 'r99'],
          },
          {
            label: 'Love the reminders',
            kind: 'positive',
            summary: 'Reminders are liked.',
            refs: [3, 'r4'],
          },
          {
            label: 'Widget',
            kind: 'feature request',
            summary: 'A widget is wanted.',
            refs: ['r4'],
          },
          { label: 'Invented', kind: 'issue', summary: 'No evidence.', refs: ['r50'] },
        ],
      },
      usage,
    });
    const res = await t.run('review_summary', { appId, days: 30 });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.insight, 'review_summary');
    assert.equal(p.reviewCount, 5, 'the old review is outside the period');
    assert.equal(p.analysed, 5);
    assert.deepEqual(
      p.sentiment,
      { positive: 2, neutral: 1, negative: 2 },
      'counted from the stars, not by the model',
    );
    assert.deepEqual(
      p.themes.map((x: { label: string; kind: string; count: number }) => [
        x.label,
        x.kind,
        x.count,
      ]),
      [
        ['Crashes on launch', 'issue', 2],
        ['Love the reminders', 'praise', 2],
        ['Widget', 'request', 1],
      ],
    );
    assert.deepEqual(
      p.themes[0].reviewIds,
      [ids[0], ids[1]],
      'evidence are real review ids; the invented ref was dropped',
    );
    assert.equal(p.themes[0].averageRating, 1.5);
    assert.ok(p.notes.some((n: string) => /not in the data/.test(n)));
    assert.ok(
      p.notes.some((n: string) => /left out/.test(n)),
      'a theme without evidence is left out and said so',
    );

    const sent = JSON.stringify(t.fake.calls[0]?.input);
    assert.ok(
      !/Pat Reviewer|pat@example\.com/.test(sent),
      'the name and the email address never leave',
    );
    assert.ok(sent.includes('[email]') && sent.includes('[name]'));
    assert.ok(!/Ancient/.test(sent));
    assert.equal(isStrictCompatible(t.fake.calls[0]?.schema ?? {}), true);
    assert.ok(
      !(await t.trail()).includes('Love the reminders'),
      'no review text in audit, events or usage',
    );

    // "Accepting" a report marks it reviewed and creates nothing.
    const done = await t.call(t.owner, 'POST', `/ai/suggestions/${res.body.suggestion.id}/accept`);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.body.result, { kind: 'insight' });
    assert.equal(done.body.suggestion.status, 'accepted');
  },
);

dbTest(
  'review_summary: no reviews, malformed output and a refused run cost what they should',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    const none = await t.run('review_summary', { appId });
    assert.equal(none.status, 422);
    assert.equal(none.body.error, 'no_reviews');
    assert.equal(t.fake.calls.length, 0, 'nothing is sent when there is nothing to read');

    await review(t, appId, 'Crashes', { rating: 1 });
    t.answer({ output: { overview: 'x' }, usage });
    const bad = await t.run('review_summary', { appId });
    assert.equal(bad.status, 502, 'themes are required: the answer is rejected');
    assert.equal(bad.body.error, 'ai_invalid_output');
    const used = await db.query(
      "SELECT status, input_tokens, output_tokens FROM ai_usage WHERE task = 'review_summary'",
    );
    assert.equal(used[0]?.status, 'failed');
    assert.equal(Number(used[0]?.input_tokens), 900, 'the tokens of a rejected answer still count');
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ai_suggestions'))[0]?.n), 0);

    // The period is validated by the route, an option the task does not have by the route as well.
    assert.equal((await t.run('review_summary', { appId, days: 500 })).status, 400);
    assert.equal(
      (await t.run('review_summary', { appId, reviewId: 'x' })).status,
      400,
      'an option this task does not have',
    );
  },
);

// ----- review_classify -----------------------------------------------------------------------------------

dbTest(
  'review_classify: reviews are tagged once; a second run sends nothing; a changed review is tagged again',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    const a = await review(t, appId, 'Crashes at start', { rating: 1, language: 'en-US' });
    const b = await review(t, appId, 'Lovely app', { rating: 5, language: 'de-DE' });
    const c = await review(t, appId, 'Slow login', { rating: 2, response: true });

    t.answer({
      output: {
        items: [
          {
            ref: 'r1',
            topics: ['Crashes', 'login'],
            sentiment: 'Negative',
            severity: 'Critical',
            needsReply: 'yes',
            language: 'en',
          },
          {
            ref: 'r2',
            topics: ['praise'],
            sentiment: 'positive',
            severity: 'none',
            needsReply: false,
            language: 'not a language tag at all',
          },
          {
            ref: 'r3',
            topics: ['something odd'],
            sentiment: 'meh',
            severity: '',
            needsReply: true,
            language: 'en',
          },
          {
            ref: 'r9',
            topics: ['bug'],
            sentiment: 'negative',
            severity: 'low',
            needsReply: true,
            language: 'en',
          },
        ],
      },
      usage,
    });
    const first = await t.run('review_classify', { appId });
    assert.equal(first.status, 201, first.text);
    const p = first.body.suggestion.proposal;
    assert.equal(p.classified, 3);
    assert.equal(p.cached, 0);
    assert.equal(p.remaining, 0);
    const byId = new Map(p.items.map((x: { reviewId: string }) => [x.reviewId, x]));
    const ta = byId.get(a) as {
      topics: string[];
      sentiment: string;
      severity: string;
      needsReply: boolean;
    };
    assert.deepEqual(
      ta.topics,
      ['crash', 'login'],
      'loose names are mapped to the fixed vocabulary',
    );
    assert.equal(ta.sentiment, 'negative');
    assert.equal(ta.severity, 'high');
    assert.equal(ta.needsReply, true);
    assert.equal(
      (byId.get(b) as { language: string }).language,
      'de-DE',
      'a bad language falls back to the one the store gave',
    );
    const tc = byId.get(c) as {
      topics: string[];
      sentiment: string;
      severity: string;
      needsReply: boolean;
    };
    assert.deepEqual(tc.topics, ['other']);
    assert.equal(
      tc.sentiment,
      'negative',
      'a sentiment the model could not name comes from the stars',
    );
    assert.equal(tc.needsReply, false, 'a review that already has a reply does not need one');
    assert.ok(p.notes.some((n: string) => /not in the data/.test(n)));
    assert.equal(
      JSON.stringify(t.fake.calls[0]?.input).includes('appContext'),
      false,
      'tags do not depend on the app context',
    );

    const tags = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/ai/review-tags?ids=${a},${b},${c},nope`,
    );
    assert.equal(tags.status, 200);
    assert.equal(tags.body.tags.length, 3);
    assert.deepEqual(Object.keys(tags.body.tags[0]).sort(), [
      'language',
      'needsReply',
      'reviewId',
      'sentiment',
      'severity',
      'topics',
    ]);
    assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/ai/review-tags`)).status, 400);

    // The cache: nothing to send, no call, no tokens.
    const calls = t.fake.calls.length;
    const again = await t.run('review_classify', { appId });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'nothing_to_do');
    assert.equal(t.fake.calls.length, calls);

    // A new review and an edited one are the only ones sent.
    const d = await review(t, appId, 'Ads everywhere', { rating: 2, daysAgo: -1 });
    await db.execute('UPDATE app_reviews SET body = ? WHERE id = ?', [
      'Lovely app, but now it crashes',
      b,
    ]);
    t.answer({
      output: {
        items: [
          {
            ref: 'r1',
            topics: ['ads'],
            sentiment: 'negative',
            severity: 'low',
            needsReply: true,
            language: 'en',
          },
          {
            ref: 'r2',
            topics: ['crash'],
            sentiment: 'mixed',
            severity: 'medium',
            needsReply: true,
            language: 'en',
          },
        ],
      },
      usage,
    });
    const next = await t.run('review_classify', { appId });
    assert.equal(next.status, 201, next.text);
    assert.equal((t.fake.calls[calls]?.input as { reviews: unknown[] }).reviews.length, 2);
    assert.equal(next.body.suggestion.proposal.cached, 2);
    const tagged = (await t.call(t.owner, 'GET', `/apps/${appId}/ai/review-tags?ids=${d},${b}`))
      .body.tags as { reviewId: string; topics: string[] }[];
    assert.equal(tagged.length, 2);
    assert.equal(
      tagged.find((x) => x.reviewId === b)?.topics[0],
      'crash',
      'the edited review was tagged again',
    );

    // Tagging specific reviews, and a review of another app.
    const other = await ios(t);
    const foreign = await review(t, other, 'Not yours', { rating: 1 });
    assert.equal((await t.run('review_classify', { appId, reviewIds: [foreign] })).status, 404);
    assert.equal(
      (await t.run('review_classify', { appId, reviewIds: [a] })).body.error,
      'nothing_to_do',
    );

    // Deleting the app deletes its tags.
    await t.call(t.owner, 'DELETE', `/apps/${appId}`);
    assert.equal(
      Number(
        (
          await db.query('SELECT COUNT(*) AS n FROM review_classifications WHERE app_id = ?', [
            appId,
          ])
        )[0]?.n,
      ),
      0,
    );
  },
);

// ----- fix_next ------------------------------------------------------------------------------------------

dbTest(
  'fix_next: complaints are ranked, versions are counted by the server, and the draft notes are checked against the limit',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    const r1 = await review(t, appId, 'Login fails', { rating: 1, version: '2.1' });
    const r2 = await review(t, appId, 'Cannot sign in', { rating: 2, version: '2.1' });
    const r3 = await review(t, appId, 'Sync is slow', { rating: 3, version: '2.0' });
    await review(t, appId, 'Great', { rating: 5, version: '2.1' });
    t.answer({
      output: {
        items: [
          { title: 'Sync speed', why: 'Slow.', area: 'sync', severity: 'low', refs: ['r3'] },
          {
            title: 'Login',
            why: 'Cannot sign in.',
            area: 'Login',
            severity: 'critical',
            refs: ['r1', 'r2', 'r42'],
          },
          { title: 'Ghost', why: 'No evidence.', area: 'x', severity: 'high', refs: [] },
        ],
        releaseNotes: 'Fixed: sign in.\nWe will refund everyone within 3 days.',
      },
      usage,
    });
    const res = await t.run('fix_next', { appId });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.insight, 'fix_next');
    assert.deepEqual(
      p.items.map((i: { title: string }) => i.title),
      ['Login', 'Sync speed'],
      'most severe first; an item without evidence is left out',
    );
    assert.deepEqual(p.items[0].versions, [{ version: '2.1', count: 2 }]);
    assert.deepEqual(p.items[0].reviewIds, [r1, r2]);
    assert.deepEqual(p.items[1].versions, [{ version: '2.0', count: 1 }]);
    assert.equal(p.items[1].reviewIds[0], r3);
    const stats = Object.fromEntries(
      p.versionStats.map((s: { version: string }) => [s.version, s]),
    );
    assert.deepEqual(
      [stats['2.1'].reviews, stats['2.1'].complaints, stats['2.1'].averageRating],
      [3, 2, 2.7],
    );
    assert.equal(p.releaseNotesLimit, 4000);
    assert.equal(p.releaseNotesLength, p.releaseNotes.length);
    assert.deepEqual(
      p.releaseNotesFlags,
      ['risky_promise'],
      'a promise of a refund and a date is flagged for a person',
    );
    const sent = t.fake.calls[0]?.input as { reviews: { ref: string; stars: number }[] };
    assert.ok(
      sent.reviews.every((r) => r.stars <= 3),
      'only complaints are sent',
    );
  },
);

// ----- listing_audit -------------------------------------------------------------------------------------

dbTest(
  'listing_audit: lengths and coverage are counted by the server; ranks the model invents are flagged; findings are ranked',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
      keywords: [
        { term: 'water reminder', country: 'us', locale: 'en-US' },
        { term: 'hydration tracker', country: 'us', locale: 'en-US' },
      ],
    });
    t.answer({
      output: {
        findings: [
          {
            field: 'Description',
            problem: 'Thin.',
            recommendation: 'Expand.',
            impact: 'LOW',
            reasoning: 'Eh.',
            keywords: [],
          },
          {
            field: 'subtitle',
            problem: 'Hydration is missing.',
            recommendation: 'Add the word.',
            impact: 'High',
            reasoning: 'You rank #4 for it already, so it should rise.',
            keywords: ['Hydration Tracker', 'invented term'],
          },
          { field: '', problem: '', recommendation: '', impact: '', reasoning: '', keywords: [] },
        ],
      },
      usage,
    });
    const res = await t.run('listing_audit', { appId, locale: 'en-US' });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.insight, 'listing_audit');
    const sub = p.fields.find((f: { field: string }) => f.field === 'subtitle');
    assert.deepEqual([sub.length, sub.limit, sub.percent], [16, 30, 53], 'counted by the server');
    assert.equal(p.fields.find((f: { field: string }) => f.field === 'keywords').unit, 'bytes');
    const cover = Object.fromEntries(p.coverage.map((c: { term: string }) => [c.term, c]));
    assert.deepEqual(
      cover['water reminder'].inFields,
      ['description'],
      'every word of the term is in the description',
    );
    assert.deepEqual(
      cover['hydration tracker'].inFields,
      [],
      'a tracked keyword that is in no field',
    );
    assert.equal(p.findings.length, 2);
    assert.equal(p.findings[0].impact, 'high', 'ranked by impact');
    assert.equal(p.findings[0].field, 'subtitle');
    assert.deepEqual(
      p.findings[0].keywords,
      ['hydration tracker'],
      'only tracked keywords are kept',
    );
    assert.deepEqual(p.findings[0].flags, ['unverified_number'], 'a rank the data did not hold');
    assert.equal(p.findings[1].field, 'description');
    const props = (
      t.fake.calls[0]?.schema as {
        properties: { findings: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.findings.items.properties;
    assert.ok(!('rank' in props), 'the schema has no field for a rank');
    assert.equal(isStrictCompatible(t.fake.calls[0]?.schema ?? {}), true);

    const none = await t.run('listing_audit', { appId, locale: 'fr-FR' });
    assert.equal(none.status, 422);
    assert.equal(none.body.error, 'no_listing_text');
  },
);

test('claimsUnknownRank only trusts the ranks that were sent', () => {
  assert.equal(claimsUnknownRank('You rank #4 for it', [4]), false);
  assert.equal(claimsUnknownRank('You rank #4 for it', [7]), true);
  assert.equal(claimsUnknownRank('You are in position 12', []), true);
  assert.equal(claimsUnknownRank('Improve the subtitle by 3 words', []), false);
});

// ----- aso_health ----------------------------------------------------------------------------------------

dbTest(
  'aso_health: five actions from the coach, the ranks and the analytics; missing analytics is said, not invented',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
      keywords: [
        { term: 'water reminder', country: 'us', locale: 'en-US' },
        { term: 'drink log', country: 'us', locale: 'en-US' },
      ],
    });
    const kws = await db.query(
      'SELECT id FROM aso_keywords WHERE app_id = ? ORDER BY term_key DESC',
      [appId],
    );
    const kw = String(kws[0]?.id);
    const check = (at: number, rank: number | null) =>
      db.execute(
        'INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, rank_pos, total, source) VALUES (?, ?, ?, ?, ?, ?, 50, ?)',
        [`c${at}`, t.workspaceId, kw, appId, at, rank, 'itunes'],
      );
    await check(Date.UTC(2026, 10, 1), 12);
    await check(Date.UTC(2026, 10, 14), 8);

    t.answer({
      output: {
        summary: 'Search is steady.',
        actions: [
          { title: 'Track more keywords', detail: 'You track two.', area: 'Keyword' },
          {
            title: 'Fix the subtitle',
            detail: 'It sits at position 3 for drink log.',
            area: 'metadata',
          },
          { title: 'A', detail: '', area: 'nonsense' },
          { title: 'B', detail: '', area: 'reviews' },
          { title: 'C', detail: '', area: 'analytics' },
          { title: 'D, one too many', detail: '', area: 'other' },
        ],
      },
      usage,
    });
    const res = await t.run('aso_health', { appId });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.actions.length, 5);
    assert.deepEqual(
      p.actions.map((a: { position: number }) => a.position),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      p.actions.map((a: { area: string }) => a.area),
      ['keywords', 'listing', 'other', 'reviews', 'analytics'],
    );
    assert.deepEqual(p.actions[1].flags, ['unverified_number'], 'position 3 was not in the data');
    assert.equal(p.basedOn.keywords, 2);
    assert.ok(p.basedOn.coachSteps >= 1);
    assert.ok(
      p.notes.some((n: string) => /analytics/i.test(n)),
      'missing analytics is said',
    );
    const sent = t.fake.calls[0]?.input as {
      rankChanges: { term: string; from: number; to: number }[];
      keywords: { tracked: number };
    };
    assert.equal(sent.rankChanges.length, 1, 'rank changes come from the stored checks');
    assert.deepEqual([sent.rankChanges[0]?.from, sent.rankChanges[0]?.to], [12, 8]);
    assert.equal(sent.keywords.tracked, 2);
  },
);

// ----- keyword_ideas_reviews -----------------------------------------------------------------------------

dbTest(
  'keyword_ideas_reviews: relevance and sources, tracked terms flagged, accepting tracks through the keyword service',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    await review(t, appId, 'I wish it had a hydration tracker like my watch', { rating: 4 });
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
      keywords: [{ term: 'water reminder', country: 'us', locale: 'en-US' }],
    });
    t.answer({
      output: {
        ideas: [
          {
            term: 'water reminder',
            reason: 'Tracked.',
            field: 'keywords',
            relevance: 90,
            sources: 'listing',
          },
          {
            term: 'hydration tracker',
            reason: 'Reviewers ask for it.',
            field: 'Subtitle',
            relevance: '85%',
            sources: 'Reviews, invented',
          },
          {
            term: 'drink log',
            reason: 'From the listing.',
            field: 'track_only',
            relevance: 40,
            sources: '',
          },
          {
            term: 'water alarm',
            reason: 'Low.',
            field: 'nowhere',
            relevance: 'high',
            sources: 'reviews, listing',
          },
          { term: 'one more', reason: 'Low.', field: 'keywords', relevance: 5, sources: '' },
        ],
      },
      usage,
    });
    const res = await t.run('keyword_ideas_reviews', { appId, locale: 'en-US', country: 'us' });
    assert.equal(res.status, 201, res.text);
    const items = res.body.suggestion.proposal.items;
    assert.deepEqual(
      items.map((i: { term: string }) => i.term),
      ['hydration tracker', 'water alarm', 'drink log', 'one more', 'water reminder'],
      'the most relevant first, what cannot be accepted last',
    );
    assert.deepEqual(
      items.map((i: { relevance: number }) => i.relevance),
      [85, 50, 40, 5, 90],
      'relevance is clamped and defaults to 50 when it is not a number',
    );
    assert.deepEqual(items[0].sources, ['reviews']);
    assert.equal(items[1].field, null);
    assert.deepEqual(items[1].flags, ['field_not_for_store']);
    assert.deepEqual(items[4].flags, ['already_tracked']);
    assert.deepEqual(
      items[1].sources,
      ['reviews', 'listing'],
      'a comma separated string is read as a list',
    );
    const sent = t.fake.calls[0]?.input as { reviews: { text: string }[] };
    assert.equal(sent.reviews.length, 1);
    const accepted = await t.call(
      t.owner,
      'POST',
      `/ai/suggestions/${res.body.suggestion.id}/accept`,
      { items: [0, 1] },
    );
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.result.created, 2);
    const tracked = await db.query(
      'SELECT tag FROM aso_keywords WHERE app_id = ? AND term_key LIKE ?',
      [appId, 'hydration%'],
    );
    assert.equal(String(tracked[0]?.tag), 'ai');
  },
);

test('keyword_ideas_reviews: a competitor name is not a keyword', () => {
  const run = {
    input: {},
    scope: {},
    facts: {
      store: 'app_store',
      country: 'us',
      locale: 'en-US',
      trackedKeys: [],
      competitorKeys: ['aquaplus'],
    },
  };
  const proposal = keywordIdeasFromReviewsTask.propose(
    {
      ideas: [
        {
          term: 'AquaPlus alternative',
          reason: 'x',
          field: 'keywords',
          relevance: 70,
          sources: 'competitors',
        },
      ],
    },
    run,
  );
  assert.equal(proposal.kind, 'keywords');
  if (proposal.kind === 'keywords') assert.deepEqual(proposal.items[0]?.flags, ['invalid_term']);
});

// ----- listing_variants ----------------------------------------------------------------------------------

dbTest(
  'listing_variants: lengths are counted by the server, limits and duplicates are flagged, one variant per field is staged',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    t.answer({
      output: {
        fields: [
          {
            field: 'subtitle',
            variants: [
              { text: 'Never forget to drink', reason: 'Direct.' },
              { text: 'X'.repeat(31), reason: 'Too long.' },
            ],
          },
          {
            field: 'Promotional Text',
            variants: [
              { text: 'Stay hydrated, one sip at a time.', reason: 'Friendly.' },
              { text: 'stay hydrated, one sip at a time.', reason: 'Same again.' },
              { text: 'Hello', reason: 'Same as now.' },
              { text: 'Your daily water coach.', reason: 'Short.' },
            ],
          },
          { field: 'description', variants: [{ text: 'not asked for', reason: '-' }] },
        ],
      },
      usage,
    });
    const res = await t.run('listing_variants', { appId, locale: 'en-US', count: 3 });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.kind, 'listing_variants');
    assert.deepEqual(
      p.fields.map((f: { field: string }) => f.field),
      ['subtitle', 'promotional_text'],
      'a field that was not asked for is dropped',
    );
    const sub = p.fields[0];
    assert.equal(sub.limit, 30);
    assert.deepEqual(
      sub.variants.map((v: { length: number; acceptable: boolean; flags: string[] }) => [
        v.length,
        v.acceptable,
        v.flags,
      ]),
      [
        [21, false, ['not_stageable']],
        [31, false, ['over_limit', 'not_stageable']],
      ],
    );
    const promo = p.fields[1].variants;
    assert.equal(promo.length, 3, 'at most the number asked for');
    assert.deepEqual(
      promo.map((v: { acceptable: boolean }) => v.acceptable),
      [true, true, false],
      'variants that can be accepted come first',
    );
    assert.deepEqual(promo[2].flags, ['duplicate']);
    assert.equal(isStrictCompatible(t.fake.calls[0]?.schema ?? {}), true);

    const id = res.body.suggestion.id as string;
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, {
          choices: [{ field: 'subtitle', variant: 0 }],
        })
      ).body.error,
      'nothing_acceptable',
      'the subtitle cannot be staged',
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, {
          choices: [{ field: 'promotional_text', variant: 9 }],
        })
      ).status,
      400,
    );
    const accepted = await t.call(t.owner, 'POST', `/ai/suggestions/${id}/accept`, {
      choices: [{ field: 'promotional_text', variant: 1 }],
    });
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(accepted.body.result, {
      kind: 'listing_text',
      stagedFields: ['promotional_text'],
      locale: 'en-US',
    });
    const staged = (await t.call(t.owner, 'GET', `/apps/${appId}/staged`)).body.staged.text;
    assert.equal(staged[0].value, p.fields[1].variants[1].text);
    assert.equal(staged[0].source, 'ai');

    const goal = await t.run('listing_variants', {
      appId,
      locale: 'en-US',
      fields: ['release_notes'],
    });
    assert.equal(goal.status, 422);
    assert.equal(goal.body.error, 'goal_needed');
  },
);

// ----- listing_translate ---------------------------------------------------------------------------------

dbTest(
  'listing_translate: the target limits, the keyword field and the brand terms are checked; accepting stages in the target language',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t, 'en-US', {
      name: 'AquaPal',
      subtitle: 'Drink more water',
      description: 'AquaPal reminds you to drink water all day long.',
      keywords: 'water,hydrate',
      promotional_text: 'Hello AquaPal',
    });
    await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, { brandTerms: ['AquaPal'] });
    t.answer({
      output: {
        fields: [
          { field: 'name', text: 'AquaPal', reason: 'Brand.' },
          { field: 'subtitle', text: 'Mehr Wasser trinken', reason: 'Natural.' },
          {
            field: 'description',
            text: 'Die App erinnert dich daran, den ganzen Tag zu trinken.',
            reason: 'Without the name.',
          },
          {
            field: 'keywords',
            text: Array.from({ length: 30 }, (_, i) => `begriff${i}`).join(','),
            reason: 'Search terms.',
          },
          { field: 'promotional_text', text: 'Hallo', reason: 'Short.' },
        ],
      },
      usage,
    });
    const res = await t.run('listing_translate', { appId, sourceLocale: 'en-US', locale: 'de-DE' });
    assert.equal(res.status, 201, res.text);
    const p = res.body.suggestion.proposal;
    assert.equal(p.locale, 'de-DE');
    const by = Object.fromEntries(p.fields.map((f: { field: string }) => [f.field, f]));
    assert.deepEqual(
      by.name.flags,
      ['not_stageable'],
      'the name cannot be staged: it is for copying',
    );
    assert.ok(
      by.description.flags.includes('brand_term_missing'),
      'a brand term of the context that went missing',
    );
    assert.equal(by.description.acceptable, true, 'a warning, not a block');
    assert.ok(by.keywords.flags.includes('trimmed'));
    assert.ok(by.keywords.length <= 100 && by.keywords.unit === 'bytes');
    const sent = t.fake.calls[0]?.input as {
      from: string;
      to: string;
      source: { field: string; targetLimit: number | null }[];
    };
    assert.deepEqual([sent.from, sent.to], ['en-US', 'de-DE']);
    assert.equal(sent.source.find((s) => s.field === 'keywords')?.targetLimit, 100);

    assert.equal(
      (
        await t.call(t.owner, 'POST', `/ai/suggestions/${res.body.suggestion.id}/accept`, {
          fields: ['subtitle'],
        })
      ).body.error,
      'nothing_acceptable',
      'the subtitle cannot be staged',
    );
    const ok = await t.call(t.owner, 'POST', `/ai/suggestions/${res.body.suggestion.id}/accept`, {
      fields: ['description', 'promotional_text'],
    });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body.result, {
      kind: 'listing_text',
      stagedFields: ['description', 'promotional_text'],
      locale: 'de-DE',
    });

    assert.equal(
      (await t.run('listing_translate', { appId, sourceLocale: 'en-US', locale: 'en-us' })).status,
      400,
      'the same language',
    );
    assert.equal(
      (await t.run('listing_translate', { appId, sourceLocale: 'fr-FR', locale: 'de-DE' })).body
        .error,
      'no_listing_text',
    );
  },
);

// ----- the reply drafts of this release -----------------------------------------------------------------

dbTest(
  'review_reply_draft v2: the tone of the app wins, the reviewer is not named, personal data blocks, promises are flagged',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, {
      tone: 'calm and brief',
      brandVoice: 'We sound like a helpful neighbour.',
      dontList: ['Do not apologise twice'],
      bannedWords: ['unfortunately'],
    });
    const reviewId = await review(
      t,
      appId,
      'Hi, Pat Reviewer here, it crashes. Call me on +49 170 1234567',
      { rating: 1, author: 'Pat Reviewer' },
    );
    t.answer({
      output: { reply: 'Thanks. Mail us at help@aqua.example and we will refund you.' },
      usage,
    });
    const res = await t.run('review_reply_draft', { appId, reviewId });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.suggestion.taskVersion, 2);
    const sent = t.fake.calls[0]?.input as { tone: string; appContext: Record<string, unknown> };
    assert.equal(sent.tone, 'as in appContext');
    assert.equal(sent.appContext.brandVoice, 'We sound like a helpful neighbour.');
    assert.ok(
      !/Pat Reviewer|1234567/.test(JSON.stringify(sent)),
      'the name and the phone number are replaced before sending',
    );
    const p = res.body.suggestion.proposal;
    assert.deepEqual(p.flags, ['personal_data', 'risky_promise']);
    assert.equal(p.acceptable, false);
    assert.equal(
      (await t.call(t.owner, 'POST', `/ai/suggestions/${res.body.suggestion.id}/accept`)).body
        .error,
      'nothing_acceptable',
    );

    t.answer({
      output: { reply: 'Unfortunately that should not happen. Thanks for telling us.' },
      usage,
    });
    const banned = (await t.run('review_reply_draft', { appId, reviewId })).body.suggestion
      .proposal;
    assert.deepEqual(banned.flags, ['banned_term']);
    assert.equal(banned.acceptable, false);

    t.answer({ output: { reply: 'Thanks for telling us. We are looking into the crash.' }, usage });
    const fine = await t.run('review_reply_draft', { appId, reviewId });
    assert.deepEqual(fine.body.suggestion.proposal.flags, []);
    const accepted = await t.call(
      t.owner,
      'POST',
      `/ai/suggestions/${fine.body.suggestion.id}/accept`,
    );
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.result.kind, 'reply_draft');
    const row = await db
      .query('SELECT status FROM review_reply_drafts WHERE review_id = ?', [reviewId])
      .catch(() => []);
    assert.ok(
      row.length === 0 || String(row[0]?.status) === 'draft',
      'what was saved is a draft: nothing was sent',
    );
  },
);

// ----- preview, cost and the soft warning --------------------------------------------------------------

dbTest(
  'preview: the exact input of a run, built from stored data, with no provider call, no usage and no suggestion',
  async (db) => {
    const t = await bootAi(db);
    await t.ready();
    const appId = await ios(t);
    await review(t, appId, 'Crashes', { rating: 1, author: 'Pat Reviewer' });
    await t.call(t.owner, 'PUT', `/apps/${appId}/ai/context`, { about: 'A water reminder.' });
    const body = { appId, days: 30 };
    const preview = await t.call(t.owner, 'POST', '/ai/tasks/review_summary/preview', body);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.preview.task.id, 'review_summary');
    assert.equal(preview.body.preview.includesAppContext, true);
    assert.equal(preview.body.preview.input.appContext.about, 'A water reminder.');
    assert.equal(preview.body.preview.input.reviews.length, 1);
    assert.ok(preview.body.preview.system.length > 50);
    assert.ok(preview.body.preview.estimatedInputTokens > 0);
    assert.equal(t.fake.calls.length, 0, 'no provider was called');
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ai_usage'))[0]?.n), 0);

    t.answer({ output: { overview: 'ok', themes: [] }, usage });
    await t.call(t.owner, 'POST', '/ai/tasks/review_summary/run', body);
    assert.deepEqual(
      t.fake.calls[0]?.input,
      preview.body.preview.input,
      'a run sends exactly what the preview showed',
    );

    assert.equal(
      (await t.call(t.owner, 'POST', '/ai/tasks/review_summary/preview', { appId: 'nope' })).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', '/ai/tasks/release_notes/preview', { appId })).status,
      409,
    );
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.call(viewer, 'POST', '/ai/tasks/review_summary/preview', body)).status,
      403,
    );
  },
);

dbTest(
  'usage: a soft warning at the threshold, the estimated cost per task, and a cost cap that refuses before anything is sent',
  async (db) => {
    const t = await bootAi(db);
    await t.ready({ monthlyTokenBudget: 20_000, softWarnPercent: 10 });
    const appId = await ios(t);
    await review(t, appId, 'Crashes', { rating: 1 });
    t.answer({
      output: { overview: 'ok', themes: [] },
      usage: { inputTokens: 1500, outputTokens: 500 },
    });
    const first = await t.run('review_summary', { appId });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.warning.level, 'soft');
    assert.equal(first.body.warning.kind, 'tokens');
    assert.equal(first.body.warning.percent, 10);

    assert.equal(
      (
        await t.configure({
          priceInputCentsPerMTok: 1_000_000,
          priceOutputCentsPerMTok: 1_000_000,
          monthlyCostCapCents: 4000,
        })
      ).status,
      200,
    );
    const cfg = (await t.call(t.owner, 'GET', '/ai/config')).body;
    assert.equal(cfg.usage.pricesSet, true);
    assert.equal(cfg.usage.estimatedCostCents, 2000, '2,000 tokens at 1,000,000 cents a million');
    assert.deepEqual(
      cfg.usage.byTask.map((x: { task: string; runs: number }) => [x.task, x.runs]),
      [['review_summary', 1]],
    );

    const calls = t.fake.calls.length;
    const refused = await t.run('review_summary', { appId });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, 'ai_cost_cap_reached');
    assert.equal(t.fake.calls.length, calls, 'refused before the provider is called');
    assert.equal(
      Number(
        (await db.query("SELECT COUNT(*) AS n FROM ai_usage WHERE task = 'review_summary'"))[0]?.n,
      ),
      1,
      'a refused run reserves nothing',
    );
  },
);

test('usageWarning: soft at the threshold, a limit at 100, and nothing without a budget or a cap', () => {
  const base = {
    used: 0,
    budget: 1000,
    costCents: 0,
    costCapCents: 0,
    softPercent: 80,
    resetsAt: Date.UTC(2026, 11, 1),
  };
  assert.equal(usageWarning({ ...base, used: 799 }), null);
  assert.equal(usageWarning({ ...base, used: 800 })?.level, 'soft');
  assert.equal(usageWarning({ ...base, used: 1000 })?.level, 'limit');
  assert.equal(
    usageWarning({ ...base, used: 900, softPercent: 0 }),
    null,
    'a threshold of 0 turns the warning off',
  );
  assert.equal(usageWarning({ ...base, budget: 0, used: 5000 }), null);
  assert.equal(usageWarning({ ...base, used: 10, costCapCents: 100, costCents: 90 })?.kind, 'cost');
});

// ----- small model helpers and the registry ----------------------------------------------------------------

test('lenient reading: a word that is almost a choice, one value for a list, text for a number', () => {
  assert.equal(
    oneOf('Negative sentiment', ['positive', 'negative'] as const, 'positive'),
    'negative',
  );
  assert.equal(oneOf('', ['a', 'b'] as const, 'b'), 'b');
  assert.deepEqual(strings('a, b , A, ', 5, 10), ['a', 'b']);
  assert.deepEqual(strings(['x', 3, null], 5, 10), ['x', '3']);
  assert.equal(
    redactPersonal(
      'Mail me: a.b@c.de or https://x.example/y or +1 (555) 123-4567, said Jo Smith',
      'Jo Smith',
    ),
    'Mail me: [email] or [link] or [number], said [name]',
  );
});

test('every ready task has a budget, a short prompt without data, a disclosure and a schema strict structured outputs accept', () => {
  for (const task of aiTasks) {
    if (task.status !== 'ready') continue;
    assert.ok(task.maxOutputTokens >= 100 && task.maxOutputTokens <= 4000, task.id);
    assert.ok(task.system.length < 2600, `${task.id}: a short prompt for a small model`);
    assert.ok(task.disclosure.sends.length > 0 && task.disclosure.neverSends.length > 0, task.id);
    assert.equal(isStrictCompatible(task.schema), true, task.id);
  }
});
