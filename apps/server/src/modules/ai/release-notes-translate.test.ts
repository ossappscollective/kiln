import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { fakeGoogle, GOOGLE_SECRET } from '../../translation-test-helpers.ts';
import { cleanModelText, isNoteLocale, translationWarnings } from './release-notes-translate.ts';
import { bootAi } from './test-helpers.ts';

/**
 * Translating the "what is new" text of a release (docs/adr/0028-release-notes-translation.md). The translation provider is a fake Google,
 * the model a scripted fake client: nothing leaves the process. The theme: the answer is TEXT, nothing is stored or staged, the text never
 * reaches the audit trail, and every limit and switch is checked before anything is sent.
 */

const SECRET = 'SECRET-NOTES-TEXT-4711';
const TEXT = `New in 2.4.0:\n- Dark mode\n- ${SECRET}`;

async function boot(db: Parameters<typeof bootAi>[0], options: Parameters<typeof bootAi>[1] = {}) {
  const google = fakeGoogle();
  const t = await bootAi(db, { ...options, app: { translation: { fetch: google.fetch } } });
  const androidId = await t.addApp('android');
  const url = (id = androidId) => `/apps/${id}/release-notes/translate`;
  const post = (body: Record<string, unknown>, cookie = t.owner, id = androidId) =>
    t.call(cookie, 'POST', url(id), body);
  const enableMachine = async () => {
    await t.addCredential('translate_google', GOOGLE_SECRET);
    const res = await t.call(t.owner, 'PUT', '/settings', { 'translation.enabled': true });
    assert.equal(res.status, 200, res.text);
  };
  return { ...t, google, androidId, url, post, enableMachine };
}
type Boot = Awaited<ReturnType<typeof boot>>;

const body = (engine: 'machine' | 'ai', over: Record<string, unknown> = {}) => ({
  engine,
  sourceLocale: 'en-US',
  text: TEXT,
  targetLocales: ['de-DE', 'fr-FR'],
  ...over,
});
const answerFor = (
  texts: Record<string, string>,
  usage = { inputTokens: 300, outputTokens: 120 },
) => ({
  output: { translations: Object.entries(texts).map(([locale, text]) => ({ locale, text })) },
  usage,
});
const staged = async (t: Boot) =>
  JSON.stringify((await t.call(t.owner, 'GET', `/apps/${t.androidId}/staged`)).body);

dbTest(
  'machine: one text, a text per language, nothing stored or staged, nothing in the audit trail',
  async (db) => {
    const t = await boot(db);
    await t.enableMachine();
    const before = await staged(t);
    const res = await t.post(body('machine'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.engine, 'machine');
    assert.equal(res.body.provider, 'google');
    assert.equal(res.body.limit, 500);
    assert.deepEqual(Object.keys(res.body.texts).sort(), ['de-DE', 'fr-FR']);
    assert.match(res.body.texts['de-DE'], /^\[de\] New in 2\.4\.0:\n- Dark mode/);
    assert.deepEqual(res.body.failed, {});
    assert.equal(res.body.usage.chars, TEXT.length * 2);
    assert.equal(t.fake.calls.length, 0, 'the AI provider is not asked for a machine translation');
    assert.equal(await staged(t), before, 'nothing is staged');
    const audit = await db.query(
      "SELECT detail FROM audit_events WHERE action = 'release_notes.translate'",
    );
    assert.equal(audit.length, 1);
    const trail = await t.trail();
    assert.ok(
      !trail.includes(SECRET) && !JSON.stringify(audit).includes(SECRET),
      'no text in the trail',
    );
    assert.deepEqual(
      {
        engine: JSON.parse(String(audit[0]?.detail)).engine,
        targets: JSON.parse(String(audit[0]?.detail)).targets,
      },
      { engine: 'machine', targets: 2 },
    );
    // The usage counts against the same daily budget as review translation.
    const settings = await t.call(t.owner, 'GET', '/settings');
    assert.equal(settings.body.translation.usage.used, TEXT.length * 2);
  },
);

dbTest(
  'machine: a provider that is not set up, or a daily budget that is used up, is the answer',
  async (db) => {
    const t = await boot(db);
    const off = await t.post(body('machine'));
    assert.equal(off.status, 422);
    assert.equal(off.body.error, 'translation_not_configured');
    assert.equal(t.google.requests.length, 0);
    await t.enableMachine();
    await t.call(t.owner, 'PUT', '/settings', { 'translation.dailyCharBudget': TEXT.length + 10 });
    const res = await t.post(body('machine'));
    // One language fits, the other does not: the answer keeps the one and says why the other has no text. The languages are
    // translated by parallel workers, so which one fits first is not fixed.
    assert.equal(res.status, 200, res.text);
    const kept = Object.keys(res.body.texts);
    assert.equal(kept.length, 1, kept.join(','));
    const lost = kept[0] === 'de-DE' ? 'fr-FR' : 'de-DE';
    assert.match(res.body.failed[lost], /daily translation budget/);
    const again = await t.post(body('machine'));
    assert.equal(again.status, 429);
    assert.equal(again.body.error, 'translation_budget');
  },
);

dbTest(
  'ai: a text per language within the limit rules, one usage row, no suggestion, nothing staged',
  async (db) => {
    const t = await boot(db);
    await t.ready();
    t.answer(
      answerFor({
        'de-DE': 'Neu in 2.4.0:\n- Dunkelmodus\n- Mehr',
        'fr-FR': `**Nouveau** en 2.4.0 : ${'x'.repeat(520)}`,
      }),
    );
    const before = await staged(t);
    const res = await t.post(body('ai'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.provider, 'anthropic');
    assert.equal(res.body.model, 'fake-model');
    assert.equal(res.body.texts['de-DE'], 'Neu in 2.4.0:\n- Dunkelmodus\n- Mehr');
    assert.ok(!res.body.texts['fr-FR'].includes('**'), 'no emphasis marks');
    assert.deepEqual(
      Object.keys(res.body.over),
      ['fr-FR'],
      'a text over 500 characters is returned and flagged',
    );
    assert.equal(res.body.limit, 500);
    assert.deepEqual(res.body.usage, { chars: 0, inputTokens: 300, outputTokens: 120 });
    // What the model was told and sent.
    const call = t.fake.calls[0];
    assert.match(call?.system ?? '', /line breaks/);
    assert.deepEqual(
      {
        limit: (call?.input as { limit: number }).limit,
        targets: (call?.input as { targets: string[] }).targets,
      },
      { limit: 500, targets: ['de-DE', 'fr-FR'] },
    );
    const usage = await db.query('SELECT task, status, input_tokens, output_tokens FROM ai_usage');
    assert.deepEqual(
      usage.map((r) => [r.task, r.status, Number(r.input_tokens), Number(r.output_tokens)]),
      [['release_notes_translate', 'ok', 300, 120]],
    );
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM ai_suggestions'))[0]?.n),
      0,
      'no proposal in the tray',
    );
    assert.equal(await staged(t), before);
    assert.ok(!(await t.trail()).includes(SECRET));
  },
);

dbTest(
  'ai: a language the model left out fails alone; a failed call fails every language of its batch',
  async (db) => {
    const t = await boot(db);
    await t.ready();
    t.answer(answerFor({ 'de-DE': 'Neu' }));
    const partial = await t.post(body('ai'));
    assert.equal(partial.status, 200);
    assert.deepEqual(Object.keys(partial.body.texts), ['de-DE']);
    assert.match(partial.body.failed['fr-FR'], /did not write a text/);
    t.answer({ error: new AiError('unavailable') });
    const down = await t.post(body('ai'));
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'ai_unavailable');
    const rows = await db.query('SELECT status, error_code FROM ai_usage ORDER BY created_at');
    assert.deepEqual(
      rows.map((r) => r.status),
      ['ok', 'failed'],
    );
  },
);

dbTest(
  'ai: off, not set up, the monthly budget and the cost cap are checked before anything is sent',
  async (db) => {
    const t = await boot(db);
    const off = await t.post(body('ai'));
    assert.equal(off.status, 409);
    assert.equal(off.body.error, 'ai_not_enabled');
    await t.ready({ monthlyTokenBudget: 1000 });
    t.answer(answerFor({ 'de-DE': 'a', 'fr-FR': 'b' }));
    const used = await t.post(body('ai'));
    assert.equal(used.status, 429, used.text);
    assert.equal(used.body.error, 'ai_budget_exhausted');
    assert.equal(t.fake.calls.length, 0, 'nothing was sent');
  },
);

dbTest(
  'ai: version numbers and the names to keep are checked, and a model that writes a code fence is cleaned',
  async (db) => {
    const t = await boot(db);
    await t.ready();
    await t.call(t.owner, 'PUT', `/apps/${t.androidId}/ai/context`, { brandTerms: ['Dark mode'] });
    t.answer(
      answerFor({
        'de-DE': '```\nNeu in 2.5.0:\n- Dunkler Modus\n```',
        'fr-FR': '"Nouveau en 2.4.0 : Dark mode"',
      }),
    );
    const res = await t.post(body('ai'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.texts['de-DE'], 'Neu in 2.5.0:\n- Dunkler Modus');
    assert.equal(res.body.texts['fr-FR'], 'Nouveau en 2.4.0 : Dark mode');
    assert.deepEqual(res.body.warnings['de-DE'], ['version_missing', 'brand_term_missing']);
    assert.equal(res.body.warnings['fr-FR'], undefined);
    assert.deepEqual((t.fake.calls[0]?.input as { appContext?: unknown }).appContext, {
      keepExactlyAsWritten: ['Dark mode'],
    });
  },
);

dbTest(
  'the request is checked: size, count, languages, the source among the targets, the role and the rate',
  async (db) => {
    const t = await boot(db, { limiterLimit: 1000 });
    await t.enableMachine();
    const bad = async (over: Record<string, unknown>) =>
      (await t.post(body('machine', over))).status;
    assert.equal(await bad({ text: 'x'.repeat(4001) }), 400);
    assert.equal(await bad({ text: '' }), 400);
    assert.equal(await bad({ text: '   ' }), 400);
    assert.equal(await bad({ targetLocales: [] }), 400);
    assert.equal(
      await bad({
        targetLocales: Array.from({ length: 41 }, (_, i) => `x${i}-AA`.replace('x', 'a')),
      }),
      400,
    );
    assert.equal(await bad({ targetLocales: ['de DE'] }), 400);
    assert.equal(await bad({ sourceLocale: '1' }), 400);
    assert.equal(await bad({ engine: 'other' }), 400);
    assert.equal(await bad({ targetLocales: ['en_us', 'EN-us'] }), 400, 'only the source language');
    assert.equal(await bad({ extra: 1 }), 400);
    assert.equal(t.google.requests.length, 0, 'nothing was sent for a bad request');
    // Duplicates and the source language are dropped.
    const ok = await t.post(
      body('machine', { targetLocales: ['de_DE', 'de-de', 'en-US', 'fr-FR'] }),
    );
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(Object.keys(ok.body.texts).sort(), ['de-DE', 'fr-FR']);
    // The text is exactly 4000 characters: allowed.
    assert.equal((await t.post(body('machine', { text: 'y'.repeat(4000) }))).status, 200);
    // Unknown app, viewer.
    assert.equal((await t.post(body('machine'), t.owner, 'nope')).status, 404);
    const viewer = await t.addMember('viewer');
    assert.equal((await t.post(body('machine'), viewer)).status, 403);
    const member = await t.addMember('member');
    assert.equal((await t.post(body('machine'), member)).status, 200, 'a member can use it');
  },
);

dbTest(
  'a token needs ai.use named for the AI engine; the rate limit answers with a wait',
  async (db) => {
    const t = await boot(db);
    await t.ready();
    await t.enableMachine();
    t.answer(answerFor({ 'de-DE': 'a', 'fr-FR': 'b' }));
    const plain = await t.makeToken({
      role: 'admin',
      actions: ['changesets.write', 'reviews.translate'],
    });
    assert.equal(
      (await t.bearer(plain, 'POST', t.url(), body('ai'))).status,
      403,
      'ai.use is not named',
    );
    assert.equal((await t.bearer(plain, 'POST', t.url(), body('machine'))).status, 200);
    const named = await t.makeToken({ role: 'admin', actions: ['changesets.write', 'ai.use'] });
    assert.equal((await t.bearer(named, 'POST', t.url(), body('ai'))).status, 200);
    assert.equal(
      (await t.bearer(named, 'POST', t.url(), body('machine'))).status,
      403,
      'reviews.translate is not named',
    );
  },
);

dbTest('the rate limit is per workspace and says when to try again', async (db) => {
  const google = fakeGoogle();
  const t = await bootAi(db, {
    app: {
      translation: {
        fetch: google.fetch,
        notesLimiter: {
          take: (() => {
            let n = 0;
            return () => (++n > 2 ? 7 : 0);
          })(),
        },
      },
    },
  });
  const id = await t.addApp('android');
  await t.addCredential('translate_google', GOOGLE_SECRET);
  await t.call(t.owner, 'PUT', '/settings', { 'translation.enabled': true });
  const go = () => t.call(t.owner, 'POST', `/apps/${id}/release-notes/translate`, body('machine'));
  assert.equal((await go()).status, 200);
  assert.equal((await go()).status, 200);
  const slow = await go();
  assert.equal(slow.status, 429);
  assert.equal(slow.body.retryAfterSeconds, 7);
});

test('pure helpers: note locales, cleaning a model text, the warnings', () => {
  for (const ok of ['en', 'en-US', 'pt_BR', 'zh-Hant-TW', 'es-419'])
    assert.equal(isNoteLocale(ok), true, ok);
  for (const bad of ['', 'e', 'en US', '1x', 'en-', `en-${'x'.repeat(40)}`])
    assert.equal(isNoteLocale(bad), false, bad);
  assert.equal(cleanModelText('  "Hello"  '), 'Hello');
  assert.equal(cleanModelText('"It said "hi" there"'), '"It said "hi" there"');
  assert.equal(cleanModelText('## Title\r\n**bold** __x__'), 'Title\nbold x');
  assert.deepEqual(translationWarnings('v 1.2.3 and 4', 'v 1.2.3 und 4', []), []);
  assert.deepEqual(translationWarnings('v 1.2.3', 'v 1.2', ['Foo']), ['version_missing']);
  assert.deepEqual(translationWarnings('Use Foo', 'Nutze fu', ['foo']), ['brand_term_missing']);
});
