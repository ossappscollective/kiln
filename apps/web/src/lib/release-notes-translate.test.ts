import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiConfig } from './ai/ai.ts';
import { ApiError } from './api.ts';
import {
  aiEngine,
  applyTranslations,
  defaultSource,
  machineEngine,
  NOTES_TRANSLATE_MAX_TARGETS,
  providerName,
  replaceText,
  type TranslateNotesResult,
  translateErrorMessage,
  translateLines,
  translatePlan,
} from './release-notes-translate.ts';

const machineOn = { enabled: true, mode: 'on_demand', target: 'en', provider: 'google' } as const;
const aiConfig = (
  over: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): AiConfig =>
  ({
    state: 'ready',
    server: { enabled: true, allowPrivateUrls: false },
    settings: {
      enabled: true,
      provider: 'anthropic',
      model: 'm',
      baseUrl: null,
      baseUrlSet: false,
    },
    providers: [{ id: 'anthropic', label: 'Anthropic (Claude)' }],
    usage: {
      month: '2026-11',
      used: 10,
      budget: 1000,
      remaining: 990,
      runs: 1,
      resetsAt: Date.UTC(2026, 11, 1),
    },
    canManage: false,
    ...over,
    ...(Object.keys(usage).length > 0
      ? {
          usage: {
            month: '2026-11',
            used: 10,
            budget: 1000,
            remaining: 990,
            runs: 1,
            resetsAt: Date.UTC(2026, 11, 1),
            ...usage,
          },
        }
      : {}),
  }) as unknown as AiConfig;

test('machine translation: hidden for a role that cannot stage text, off with the setting to change, quiet when unknown', () => {
  assert.equal(machineEngine({ role: 'viewer', config: machineOn }).visible, false);
  assert.deepEqual(
    (({ visible, enabled }) => ({ visible, enabled }))(
      machineEngine({ role: 'member', config: machineOn }),
    ),
    { visible: true, enabled: true },
  );
  assert.match(
    machineEngine({ role: 'member', config: machineOn }).sends,
    /sent to Google Cloud Translation/,
  );
  const off = machineEngine({ role: 'member', config: { ...machineOn, enabled: false } });
  assert.equal(off.enabled, false);
  assert.match(off.reason ?? '', /An admin can turn it on in Settings, in the Translation card/);
  assert.equal(off.href, '#/settings');
  assert.match(
    machineEngine({ role: 'admin', config: { ...machineOn, mode: 'off' } }).reason ?? '',
    /^Machine translation is off\. Turn it on/,
  );
  // Not read yet: waits. Cannot be read: the server decides.
  assert.equal(machineEngine({ role: 'member', config: undefined }).enabled, false);
  assert.equal(machineEngine({ role: 'member', config: null }).enabled, true);
});

test('AI: hidden without ai.use, off with the setting to change, off when the month is used up unless the model is local', () => {
  assert.equal(aiEngine({ role: 'viewer', config: aiConfig() }).visible, false);
  const ready = aiEngine({ role: 'member', config: aiConfig() });
  assert.deepEqual([ready.visible, ready.enabled], [true, true]);
  assert.match(ready.sends, /Anthropic \(Claude\)/);
  assert.match(
    aiEngine({ role: 'member', config: aiConfig({ state: 'off_server' }) }).reason ?? '',
    /KILN_AI_ENABLED/,
  );
  const off = aiEngine({ role: 'member', config: aiConfig({ state: 'off_workspace' }) });
  assert.match(off.reason ?? '', /An admin can turn it on in Settings, in the AI view/);
  assert.equal(off.href, '#/settings?view=ai');
  assert.match(
    aiEngine({ role: 'admin', config: aiConfig({ state: 'not_configured' }) }).reason ?? '',
    /^AI assistance is not set up yet\. Finish it in Settings/,
  );
  const used = { used: 1000, remaining: 0 };
  assert.match(
    aiEngine({ role: 'member', config: aiConfig({}, used) }).reason ?? '',
    /monthly AI limit is used up\. It starts again on (?:1 December|December 1)\.$/,
  );
  assert.match(
    aiEngine({ role: 'admin', config: aiConfig({}, used) }).reason ?? '',
    /you can raise it/,
  );
  const local = aiConfig(
    { settings: { provider: 'openai_compatible', baseUrl: 'http://localhost:1234/v1' } },
    used,
  );
  assert.equal(
    aiEngine({ role: 'member', config: local }).enabled,
    true,
    'a local model is not stopped by the monthly limit',
  );
  const remote = aiConfig(
    { settings: { provider: 'openai_compatible', baseUrl: 'https://models.example.com/v1' } },
    used,
  );
  assert.equal(aiEngine({ role: 'member', config: remote }).enabled, false);
  assert.equal(aiEngine({ role: 'member', config: null }).enabled, false);
  assert.equal(aiEngine({ role: 'member', config: null, failed: true }).enabled, true);
});

test('the default source is the first language with text; a plan counts what would be replaced', () => {
  const texts = { 'de-DE': '', 'en-US': 'Hello', 'fr-FR': 'Bonjour', 'es-ES': '  ' };
  const locales = ['de-DE', 'en-US', 'fr-FR', 'es-ES'];
  assert.equal(defaultSource(texts, locales), 'en-US');
  assert.equal(defaultSource(texts, locales, 'en_us'), 'fr-FR');
  assert.equal(defaultSource({}, locales), null);
  const plan = translatePlan(texts, locales, 'en-US');
  assert.deepEqual(plan.targets, ['de-DE', 'fr-FR', 'es-ES']);
  assert.deepEqual([plan.replaces, plan.fills, plan.problem], [1, 2, null]);
  assert.equal(plan.text, 'Hello');
  assert.equal(replaceText(1), 'This replaces 1 text that is not empty.');
  assert.equal(replaceText(2), 'This replaces 2 texts that are not empty.');
  // One language only.
  assert.deepEqual(translatePlan(texts, locales, 'en-US', ['fr-FR']).targets, ['fr-FR']);
});

test('a plan has a problem instead of a request when there is no text, too much text or nobody to translate into', () => {
  assert.match(translatePlan({ a: '' }, ['a', 'b'], 'a').problem ?? '', /^Write the a text first/);
  assert.match(
    translatePlan({ a: 'x'.repeat(4001) }, ['a', 'b'], 'a').problem ?? '',
    /4001 characters.*4000/,
  );
  assert.equal(
    translatePlan({ a: 'x' }, ['a'], 'a').problem,
    'There is no other language to translate into.',
  );
  const many = Array.from({ length: 85 }, (_, i) => `l${i}-AA`);
  const plan = translatePlan({ 'l0-AA': 'x' }, many, 'l0-AA');
  assert.deepEqual(
    plan.chunks.map((c) => c.length),
    [NOTES_TRANSLATE_MAX_TARGETS, NOTES_TRANSLATE_MAX_TARGETS, 4],
  );
});

const result = (over: Partial<TranslateNotesResult> = {}): TranslateNotesResult => ({
  engine: 'machine',
  provider: 'google',
  model: null,
  texts: {},
  failed: {},
  over: {},
  warnings: {},
  limit: 500,
  usage: { chars: 0, inputTokens: 0, outputTokens: 0 },
  warning: null,
  ...over,
});

test('answers are merged per language: what worked is kept, the source is never touched, failures are listed', () => {
  const drafts = { 'en-US': 'Hello', 'de-DE': 'Alt', 'fr-FR': 'Vieux', 'es-ES': '' };
  const out = applyTranslations(
    drafts,
    ['de-DE', 'fr-FR', 'es-ES'],
    [
      {
        ok: true,
        result: result({
          texts: { 'de-DE': 'Hallo', 'en-US': 'ignored' },
          failed: { 'fr-FR': 'The daily budget is used up.' },
        }),
      },
    ],
  );
  assert.deepEqual(out.drafts, {
    'en-US': 'Hello',
    'de-DE': 'Hallo',
    'fr-FR': 'Vieux',
    'es-ES': '',
  });
  assert.deepEqual(out.applied, ['de-DE']);
  assert.deepEqual(out.failed, [
    { locale: 'fr-FR', message: 'The daily budget is used up.' },
    { locale: 'es-ES', message: 'No answer came back for this language.' },
  ]);
});

test('a request that failed does not lose the ones that worked; over-long texts and warnings are reported; server tags are matched loosely', () => {
  const out = applyTranslations(
    { 'pt-BR': '' },
    ['pt-BR', 'de-DE', 'ja-JP'],
    [
      {
        ok: true,
        result: result({
          texts: { 'pt-br': 'x'.repeat(600), 'de-DE': 'Hallo 2.4' },
          warnings: { 'de-DE': ['version_missing'] },
          warning: {
            kind: 'tokens',
            level: 'soft',
            percent: 85,
            message: '85% of the monthly limit is used.',
          },
        }),
      },
      { ok: false, message: 'Too many requests.', locales: ['ja-JP'] },
    ],
  );
  assert.deepEqual(out.applied, ['pt-BR', 'de-DE']);
  assert.equal(out.drafts['pt-BR']?.length, 600);
  assert.deepEqual(out.over, [{ locale: 'pt-BR', chars: 600, limit: 500 }]);
  assert.deepEqual(out.warnings, [{ locale: 'de-DE', codes: ['version_missing'] }]);
  assert.deepEqual(out.failed, [{ locale: 'ja-JP', message: 'Too many requests.' }]);
  const lines = translateLines(out, 'ai', 'Anthropic (Claude)');
  assert.equal(lines.tone, 'warn');
  assert.equal(
    lines.lines[0],
    'Put the AI by Anthropic (Claude) text in 2 languages: pt-BR, de-DE. Read it before you stage it. Not staged yet.',
  );
  assert.deepEqual(lines.lines.slice(1), [
    'Not translated: ja-JP (Too many requests.).',
    'Too long for the store, shorten before staging: pt-BR (600 of 500).',
    'Check de-DE: a version number of the source is missing.',
    '85% of the monthly limit is used.',
  ]);
});

test('nothing translated says the editors are as they were', () => {
  const out = applyTranslations(
    { a: 'x' },
    ['b'],
    [{ ok: false, message: 'Not set up.', locales: ['b'] }],
  );
  const lines = translateLines(out, 'machine', '');
  assert.equal(lines.tone, 'error');
  assert.equal(lines.lines[0], 'Nothing was translated. The editors are as they were.');
  assert.deepEqual(out.drafts, { a: 'x' });
});

test('provider names and error sentences come from fixed codes', () => {
  assert.equal(providerName('machine', 'google'), 'Google Cloud Translation');
  assert.equal(providerName('ai', 'anthropic'), 'Anthropic (Claude)');
  assert.equal(providerName('ai', 'unknown'), 'unknown');
  const err = (status: number, code: string, body: Record<string, unknown> = {}) =>
    new ApiError(status, code, 'server words', undefined, body);
  assert.match(
    translateErrorMessage(err(422, 'translation_not_configured', { reason: 'disabled' })),
    /Translation is turned off/,
  );
  assert.match(
    translateErrorMessage(err(429, 'ai_budget_exhausted', { resetsAt: Date.UTC(2026, 11, 1) })),
    /starts again on (?:1 December|December 1)/,
  );
  assert.match(translateErrorMessage(err(403, 'forbidden')), /Your role does not allow that/);
  assert.equal(translateErrorMessage(new Error('boom')), 'That did not work. Try again.');
});
