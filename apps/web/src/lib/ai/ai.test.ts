import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiProposal } from '@mrm/core';
import {
  ADDRESS_TEXTS,
  type AiConfig,
  acceptableIndexes,
  acceptBody,
  acceptedNote,
  acceptLabel,
  addressAdvice,
  aiChanges,
  aiErrorMessage,
  aiSaveMessage,
  aiStateInfo,
  aiTestSample,
  aiTestText,
  budgetUsedUp,
  canAutoLoadModels,
  canImproveField,
  createDisclosureGate,
  type DisclosureStorage,
  disclosureKey,
  formFromConfig,
  isAiDirty,
  isLocalAddress,
  looksPrivateAddress,
  meterFor,
  modelNotListed,
  modelOptions,
  modelsBody,
  modelsNote,
  modelsSignature,
  needsReplace,
  needsV1Hint,
  oldestCredentialOfKind,
  openSuggestions,
  proposalRows,
  providerSentence,
  resetText,
  suggestAvailability,
  toggleSelection,
  usageFraction,
  usageText,
  validateAiForm,
} from './ai.ts';
import { ApiError } from '../api.ts';

const providers: AiConfig['providers'] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    credentialKind: 'ai_anthropic',
    credentialRequired: true,
    needsUrl: false,
    privacy: 'p',
    credentialPresent: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    credentialKind: 'ai_openai',
    credentialRequired: true,
    needsUrl: false,
    privacy: 'p',
    credentialPresent: false,
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI compatible server',
    credentialKind: 'ai_openai_compatible',
    credentialRequired: false,
    needsUrl: true,
    privacy: 'p',
    credentialPresent: false,
  },
];

const config = (over: Partial<AiConfig> = {}): AiConfig => ({
  state: 'ready',
  server: { enabled: true, allowPrivateUrls: false },
  settings: {
    enabled: true,
    provider: 'anthropic',
    model: 'm1',
    baseUrl: null,
    baseUrlSet: false,
    monthlyTokenBudget: 500000,
    maxOutputTokens: 4000,
    maxInputTokens: 8000,
  },
  defaults: { monthlyTokenBudget: 500000, maxOutputTokens: 4000, maxInputTokens: 8000 },
  overridden: [],
  providers,
  usage: {
    month: '2026-11',
    used: 900,
    budget: 500000,
    remaining: 499100,
    runs: 1,
    resetsAt: Date.UTC(2026, 11, 1),
  },
  limits: { maxMonthlyTokenBudget: 1000000000 },
  canManage: true,
  ...over,
});

const apiError = (
  status: number,
  code: string,
  body: Record<string, unknown> = {},
  retryAfter?: number,
) => new ApiError(status, code, 'a message that must never be shown', retryAfter, body);

// ----- state to message

test('every state says where AI stands, and an off server names the environment flag', () => {
  const off = aiStateInfo(config({ state: 'off_server' }));
  assert.equal(off.tone, 'info');
  assert.match(off.message, /MRM_AI_ENABLED=true/);
  assert.match(aiStateInfo(config({ state: 'off_workspace' })).message, /Turn it on below/);
  assert.match(
    aiStateInfo(config({ state: 'off_workspace', canManage: false })).message,
    /An admin can turn it on/,
  );
  assert.equal(aiStateInfo(config()).tone, 'ok');
  assert.match(aiStateInfo(config()).message, /Anthropic \(Claude\)/);
});

test('not configured names what is missing for an admin, and only who can fix it for others', () => {
  const reasons = [
    'no_model',
    'no_credential',
    'no_url',
    'credential_unreadable',
    'bad_url',
  ] as const;
  const seen = new Set<string>();
  for (const reason of reasons) {
    const admin = aiStateInfo(config({ state: 'not_configured', reason }));
    assert.equal(admin.tone, 'warn');
    seen.add(admin.message);
    const member = aiStateInfo(config({ state: 'not_configured', reason, canManage: false }));
    assert.match(member.message, /An admin can finish it/);
  }
  assert.equal(seen.size, reasons.length);
});

test('the provider sentence says who receives the text', () => {
  assert.equal(
    providerSentence(providers[0] ?? null),
    'Text you choose is sent to Anthropic (Claude).',
  );
  assert.match(providerSentence(providers[2] ?? null), /server whose address you enter/);
  assert.match(providerSentence(null), /AI provider you set up/);
});

test('usage reads as words and a fraction, with and without a limit', () => {
  assert.equal(
    usageText({ used: 1200, budget: 500000, resetsAt: Date.UTC(2026, 11, 1) }),
    '1,200 of 500,000 used this month. Starts again on 1 December.',
  );
  assert.match(usageText({ used: 5, budget: 0, resetsAt: 0 }), /No limit is set here/);
  assert.equal(usageFraction({ used: 250, budget: 1000 }), 0.25);
  assert.equal(usageFraction({ used: 2000, budget: 1000 }), 1);
  assert.equal(usageFraction({ used: 10, budget: 0 }), null);
  assert.equal(resetText(Date.UTC(2027, 0, 1)), '1 January');
  assert.equal(budgetUsedUp({ budget: 100, remaining: 0 }), true);
  assert.equal(budgetUsedUp({ budget: 100, remaining: 5 }), false);
  assert.equal(budgetUsedUp({ budget: 0, remaining: null }), false);
});

// ----- who sees a Suggest control

test('a Suggest control is hidden when AI is off, unknown, or the role cannot use or accept', () => {
  assert.equal(
    suggestAvailability({ role: 'member', config: null, kind: 'keywords' }).visible,
    false,
  );
  assert.equal(
    suggestAvailability({
      role: 'member',
      config: config({ state: 'off_server' }),
      kind: 'keywords',
    }).visible,
    false,
  );
  assert.equal(
    suggestAvailability({
      role: 'member',
      config: config({ state: 'off_workspace' }),
      kind: 'keywords',
    }).visible,
    false,
  );
  assert.equal(
    suggestAvailability({ role: 'viewer', config: config(), kind: 'keywords' }).visible,
    false,
  );
  assert.deepEqual(
    suggestAvailability({ role: 'member', config: config(), kind: 'listing_text' }),
    { visible: true, enabled: true, reason: null },
  );
});

test('a Suggest control is disabled with the reason when AI is not ready or the limit is used up', () => {
  const missing = suggestAvailability({
    role: 'member',
    config: config({ state: 'not_configured', reason: 'no_credential', canManage: false }),
    kind: 'reply_draft',
  });
  assert.equal(missing.visible, true);
  assert.equal(missing.enabled, false);
  assert.match(missing.reason ?? '', /not set up/);
  const spent = suggestAvailability({
    role: 'admin',
    config: config({ usage: { ...config().usage, remaining: 0 } }),
    kind: 'keywords',
  });
  assert.equal(spent.enabled, false);
  assert.match(spent.reason ?? '', /monthly limit is used up/);
});

// ----- disclosure gating

function memoryStorage(): DisclosureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const task = { id: 'keyword_ideas', version: 1 };

test('the disclosure is shown before the first run and then once per session', () => {
  const store = memoryStorage();
  const gate = createDisclosureGate(() => store);
  assert.equal(gate.needs(task, 'anthropic'), true);
  gate.confirm(task, 'anthropic', false);
  assert.equal(gate.needs(task, 'anthropic'), false);
  assert.equal(store.data.size, 0, 'nothing is kept beyond the session without the tick');
  assert.equal(
    createDisclosureGate(() => store).needs(task, 'anthropic'),
    true,
    'a new session asks again',
  );
  assert.equal(
    gate.needs({ id: 'listing_improve', version: 1 }, 'anthropic'),
    true,
    'each task has its own',
  );
});

test('"Don\'t ask again" is kept per task, and a new provider or task version asks again', () => {
  const store = memoryStorage();
  const gate = createDisclosureGate(() => store);
  gate.confirm(task, 'anthropic', true);
  assert.equal(store.data.get(disclosureKey('keyword_ideas')), '1:anthropic');
  const later = createDisclosureGate(() => store);
  assert.equal(later.needs(task, 'anthropic'), false);
  assert.equal(later.needs(task, 'openai'), true, 'who receives the text changed');
  assert.equal(
    later.needs({ id: 'keyword_ideas', version: 2 }, 'anthropic'),
    true,
    'what is sent changed',
  );
  assert.equal(later.needs({ id: 'listing_improve', version: 1 }, 'anthropic'), true);
});

test('a missing or refusing storage never throws, it just asks again', () => {
  const broken: DisclosureStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  const gate = createDisclosureGate(() => broken);
  assert.equal(gate.needs(task, 'anthropic'), true);
  gate.confirm(task, 'anthropic', true);
  assert.equal(gate.needs(task, 'anthropic'), false, 'the session still remembers');
  const none = createDisclosureGate(() => null);
  assert.equal(none.needs(task, 'anthropic'), true);
  none.confirm(task, 'anthropic', true);
  assert.equal(none.needs(task, 'anthropic'), false);
  const thrower = createDisclosureGate(() => {
    throw new Error('no storage');
  });
  assert.equal(thrower.needs(task, null), true);
});

// ----- proposals as rows

const keywordProposal: AiProposal = {
  kind: 'keywords',
  store: 'app_store',
  country: 'us',
  locale: 'en-US',
  items: [
    {
      term: 'hydration tracker',
      reason: 'Matches the description.',
      field: 'keywords',
      acceptable: true,
      flags: [],
    },
    { term: 'water', reason: 'Short.', field: null, acceptable: false, flags: ['already_tracked'] },
    { term: 'drink log', reason: '<b>bold</b>', field: null, acceptable: true, flags: [] },
  ],
};

test('keyword ideas become rows with the reason as plain text, flags and the reason an item is blocked', () => {
  const rows = proposalRows(keywordProposal);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.title, 'hydration tracker');
  assert.equal(rows[0]?.note, 'Where it would go: Keyword field');
  assert.equal(rows[2]?.note, 'Where it would go: no listing field, tracking only');
  assert.equal(rows[1]?.acceptable, false);
  assert.deepEqual(
    rows[1]?.flags.map((f) => f.text),
    ['Already tracked'],
  );
  assert.match(rows[1]?.blocked ?? '', /already tracked/);
  assert.equal(
    rows[2]?.reason,
    '<b>bold</b>',
    'text is data: it is passed on as it is and shown as text',
  );
  assert.deepEqual(acceptableIndexes(rows), [0, 2]);
});

const listingProposal: AiProposal = {
  kind: 'listing_text',
  locale: 'en-US',
  fields: [
    {
      field: 'keywords',
      text: 'water,hydrate',
      reason: 'Fits.',
      length: 13,
      limit: 100,
      unit: 'bytes',
      acceptable: true,
      flags: ['trimmed'],
    },
    {
      field: 'description',
      text: 'x'.repeat(10),
      reason: 'Long.',
      length: 4100,
      limit: 4000,
      unit: 'characters',
      acceptable: false,
      flags: ['over_limit'],
    },
  ],
};

test('listing text becomes rows with a meter, the trimmed and over limit flags, and over limit cannot be accepted', () => {
  const rows = proposalRows(listingProposal);
  assert.equal(rows[0]?.title, 'Keyword field');
  assert.deepEqual(
    rows[0]?.flags.map((f) => [f.flag, f.tone]),
    [['trimmed', 'warn']],
  );
  assert.equal(rows[0]?.acceptable, true);
  assert.deepEqual(rows[0]?.meter, {
    used: 13,
    limit: 100,
    remaining: 87,
    over: false,
    unit: 'bytes',
    percent: 13,
  });
  assert.equal(rows[1]?.meter?.over, true);
  assert.equal(rows[1]?.meter?.percent, 100);
  assert.equal(rows[1]?.acceptable, false);
  assert.match(rows[1]?.blocked ?? '', /longer than the store allows/);
});

test('a reply becomes one row with its length against the limit', () => {
  const rows = proposalRows({
    kind: 'reply_draft',
    reviewId: 'r1',
    store: 'googleplay',
    text: 'Thanks for the feedback.',
    length: 24,
    limit: 350,
    acceptable: true,
    flags: ['cleaned'],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, 'Thanks for the feedback.');
  assert.equal(rows[0]?.meter?.limit, 350);
  assert.deepEqual(
    rows[0]?.flags.map((f) => f.text),
    ['Odd characters removed'],
  );
  const html = proposalRows({
    kind: 'reply_draft',
    reviewId: 'r1',
    store: 'googleplay',
    text: '<p>hi</p>',
    length: 9,
    limit: 350,
    acceptable: false,
    flags: ['markup'],
  });
  assert.equal(html[0]?.acceptable, false);
  assert.match(html[0]?.blocked ?? '', /plain text/);
});

test('a meter reports remaining, over and the fill', () => {
  assert.deepEqual(meterFor(30, 30, 'characters'), {
    used: 30,
    limit: 30,
    remaining: 0,
    over: false,
    unit: 'characters',
    percent: 100,
  });
  assert.equal(meterFor(35, 30, 'characters').over, true);
  assert.equal(meterFor(0, 0, 'characters').percent, 0);
});

// ----- selection and the accept payload

test('a selection starts with everything acceptable and never holds a row that cannot be accepted', () => {
  const rows = proposalRows(keywordProposal);
  assert.deepEqual(toggleSelection(rows, [0, 2], 0, false), [2]);
  assert.deepEqual(toggleSelection(rows, [2], 0, true), [0, 2]);
  assert.deepEqual(toggleSelection(rows, [0], 1, true), [0], 'a blocked row cannot be ticked');
  assert.deepEqual(
    toggleSelection(rows, [0, 1], 2, true),
    [0, 2],
    'a blocked row already in the list is dropped',
  );
});

test('the accept payload names exactly the ticked rows, by position for keywords and by field for listing text', () => {
  const kw = proposalRows(keywordProposal);
  assert.deepEqual(acceptBody(keywordProposal, kw, [0, 2]), { items: [0, 2] });
  assert.deepEqual(
    acceptBody(keywordProposal, kw, [1, 2]),
    { items: [2] },
    'a blocked row is never sent',
  );
  assert.deepEqual(acceptBody(keywordProposal, kw, []), { items: [] });
  const li = proposalRows(listingProposal);
  assert.deepEqual(acceptBody(listingProposal, li, [0, 1]), { fields: ['keywords'] });
  assert.deepEqual(acceptBody(listingProposal, li, [0], true), {
    fields: ['keywords'],
    replace: true,
  });
  const reply: AiProposal = {
    kind: 'reply_draft',
    reviewId: 'r',
    store: 'googleplay',
    text: 't',
    length: 1,
    limit: 350,
    acceptable: true,
    flags: [],
  };
  assert.deepEqual(acceptBody(reply, proposalRows(reply), [0]), {});
  assert.deepEqual(acceptBody(reply, proposalRows(reply), [0], true), { replace: true });
});

test('what accepting did points to where the result lives', () => {
  const kw = acceptedNote(
    { kind: 'keywords', keywordIds: ['a'], created: 2, existing: 1, rejected: 0 },
    'app 1',
    'ios',
  );
  assert.equal(kw.text, 'Added 2 keywords, 1 already tracked.');
  assert.equal(kw.href, '#/portfolio/app%201/insights?platform=ios&view=keywords');
  assert.equal(kw.linkLabel, 'Show them');
  // It says where they went, and the link opens that platform even when the page is on the whole app.
  const where = acceptedNote(
    {
      kind: 'keywords',
      keywordIds: [],
      created: 8,
      existing: 0,
      rejected: 0,
      locale: 'en-US',
      country: 'us',
      remaining: 0,
    },
    'a1',
    'both',
    'ios',
  );
  assert.equal(where.text, 'Added 8 keywords to iOS · en-US.');
  assert.equal(where.href, '#/portfolio/a1/insights?platform=ios&view=keywords');
  const part = acceptedNote(
    {
      kind: 'keywords',
      keywordIds: [],
      created: 1,
      existing: 0,
      rejected: 0,
      locale: 'de-DE',
      remaining: 3,
    },
    'a1',
    null,
    'android',
  );
  assert.equal(part.text, 'Added 1 keyword to Android · de-DE. 3 ideas are still proposed.');
  assert.equal(
    acceptedNote(
      { kind: 'keywords', keywordIds: [], created: 0, existing: 2, rejected: 0, locale: 'en-US' },
      'a1',
      null,
      'ios',
    ).text,
    'Nothing new for iOS · en-US, 2 already tracked.',
  );
  const li = acceptedNote(
    { kind: 'listing_text', stagedFields: ['keywords', 'promotional_text'], locale: 'de-DE' },
    'a1',
  );
  assert.match(
    li.text,
    /Staged 2 texts for de-DE \(Keyword field, Promotional text\)\. Nothing is sent to a store/,
  );
  assert.equal(li.href, '#/portfolio/a1/pending');
  assert.equal(li.linkLabel, 'Open Pending changes');
  const re = acceptedNote({ kind: 'reply_draft', reviewId: 'r', draftId: 'd' }, 'a1');
  assert.match(re.text, /Nothing is sent/);
  assert.equal(re.href, '#/portfolio/a1/reviews');
});

test('only a proposed suggestion is open', () => {
  const s = (status: 'proposed' | 'accepted' | 'dismissed') => ({ status }) as never;
  assert.equal(openSuggestions([s('proposed'), s('accepted'), s('dismissed')]).length, 1);
});

test('Improve is offered for the fields a draft push can write, per store', () => {
  assert.equal(canImproveField('ios', 'description'), true);
  assert.equal(canImproveField('ios', 'promotional_text'), true);
  assert.equal(canImproveField('ios', 'name'), false);
  assert.equal(canImproveField('macos', 'keywords'), true);
  assert.equal(canImproveField('android', 'short_description'), true);
  assert.equal(canImproveField('android', 'keywords'), false);
});

// ----- errors from fixed codes

test('errors are fixed sentences chosen from the code, never the server or provider text', () => {
  for (const [status, code] of [
    [409, 'ai_not_enabled'],
    [422, 'ai_not_configured'],
    [422, 'ai_auth'],
    [429, 'ai_budget_exhausted'],
    [502, 'ai_invalid_output'],
    [502, 'ai_unavailable'],
    [409, 'suggestion_not_proposed'],
    [422, 'nothing_acceptable'],
  ] as const) {
    const text = aiErrorMessage(
      apiError(status, code, { message: 'RAW PROVIDER TEXT', reason: 'http_500' }),
    );
    assert.ok(text.length > 10, code);
    assert.ok(!/RAW PROVIDER TEXT|must never be shown/.test(text), code);
  }
  assert.match(
    aiErrorMessage(apiError(409, 'ai_not_enabled', { reason: 'server' })),
    /MRM_AI_ENABLED=true/,
  );
  assert.match(
    aiErrorMessage(apiError(409, 'ai_not_enabled', { reason: 'workspace' })),
    /off for this workspace/,
  );
  assert.match(
    aiErrorMessage(apiError(429, 'ai_budget_exhausted', { resetsAt: Date.UTC(2026, 11, 1) })),
    /1 December/,
  );
  assert.match(aiErrorMessage(apiError(429, 'ai_busy', {}, 30)), /30 seconds/);
  assert.match(aiErrorMessage(apiError(429, 'rate_limited', {}, 90)), /2 minutes/);
  assert.match(
    aiErrorMessage(apiError(504, 'ai_unavailable', { reason: 'timeout' })),
    /did not answer in time/,
  );
  assert.match(
    aiErrorMessage(apiError(502, 'ai_unavailable', { reason: 'http_500' })),
    /could not be reached/,
  );
  assert.equal(aiErrorMessage(new Error('x'), 'Fallback.'), 'Fallback.');
  assert.equal(
    aiErrorMessage(apiError(0, 'network')),
    'a message that must never be shown',
    'a network failure keeps the api sentence',
  );
  assert.equal(aiErrorMessage(apiError(418, 'something_new'), 'Fallback.'), 'Fallback.');
  assert.equal(
    aiErrorMessage(apiError(500, 'something_new')),
    'The server had a problem. Try again.',
  );
});

test('a clash with something already there asks for a replace, other refusals do not', () => {
  assert.equal(needsReplace(apiError(409, 'staged_exists')), true);
  assert.equal(needsReplace(apiError(409, 'draft_exists')), true);
  assert.equal(needsReplace(apiError(409, 'suggestion_not_proposed')), false);
  assert.equal(needsReplace(new Error('x')), false);
});

test('a test of the connection reads as a fixed sentence', () => {
  assert.equal(
    aiTestText({ ok: true, provider: 'anthropic', model: 'm1' }, providers).text,
    'Connected to Anthropic (Claude). The model m1 answered.',
  );
  assert.match(
    aiTestText({ ok: false, kind: 'auth', message: 'RAW' }).text,
    /did not accept the key/,
  );
  assert.match(
    aiTestText({ ok: false, kind: 'unavailable', reason: 'timeout' }).text,
    /did not answer in time/,
  );
  assert.match(
    aiTestText({ ok: false, kind: 'unavailable', reason: 'address_not_allowed' }).text,
    /does not allow that address/,
  );
  assert.match(
    aiTestText({ ok: false, kind: 'unavailable', reason: 'http_500' }).text,
    /could not be reached/,
  );
  assert.ok(!/RAW/.test(aiTestText({ ok: false, kind: 'weird', message: 'RAW' }).text));
  assert.equal(aiTestText({ ok: false }).ok, false);
});

// ----- the settings form

test('the form starts from the saved settings with an empty key, and a change names only what differs', () => {
  const c = config();
  const form = formFromConfig(c);
  assert.equal(form.apiKey, '');
  assert.equal(form.budget, '500000');
  assert.deepEqual(aiChanges(c, form), {});
  assert.equal(isAiDirty(c, form), false);
  assert.deepEqual(aiChanges(c, { ...form, enabled: false, model: ' m2 ', budget: '0' }), {
    enabled: false,
    model: 'm2',
    monthlyTokenBudget: 0,
  });
  assert.deepEqual(
    aiChanges(c, { ...form, model: '' }),
    { model: null },
    'an empty model resets it',
  );
  assert.deepEqual(
    aiChanges(c, { ...form, provider: 'openai_compatible', baseUrl: 'http://localhost:11434' }),
    { provider: 'openai_compatible', baseUrl: 'http://localhost:11434' },
  );
  assert.equal(isAiDirty(c, { ...form, apiKey: 'sk-test' }), true, 'a new key alone is a change');
  assert.deepEqual(aiChanges(c, { ...form, apiKey: 'sk-test' }), {}, 'the key is not a setting');
});

test('the form is validated before saving', () => {
  const c = config();
  const form = formFromConfig(c);
  assert.deepEqual(validateAiForm(form, c), {});
  assert.ok(validateAiForm({ ...form, model: 'has space' }, c).model);
  assert.ok(validateAiForm({ ...form, budget: '-1' }, c).budget);
  assert.ok(validateAiForm({ ...form, budget: '2000000000' }, c).budget);
  assert.ok(validateAiForm({ ...form, budget: '' }, c).budget);
  assert.ok(validateAiForm({ ...form, baseUrl: 'ftp://x' }, c).baseUrl);
  assert.ok(validateAiForm({ ...form, baseUrl: 'https://user:pw@host' }, c).baseUrl);
  assert.equal(
    validateAiForm({ ...form, baseUrl: 'https://models.example.com/v1' }, c).baseUrl,
    undefined,
  );
  assert.ok(validateAiForm({ ...form, apiKey: 'has a space' }, c).apiKey);
  assert.equal(validateAiForm({ ...form, apiKey: 'sk-ant-123' }, c).apiKey, undefined);
});

test('the credential that holds the key is the oldest of its kind', () => {
  const list = [
    { id: 'b', kind: 'ai_anthropic', createdAt: 20 },
    { id: 'a', kind: 'ai_anthropic', createdAt: 10 },
    { id: 'c', kind: 'ai_openai', createdAt: 5 },
  ];
  assert.equal(oldestCredentialOfKind(list, 'ai_anthropic')?.id, 'a');
  assert.equal(oldestCredentialOfKind(list, 'ai_openai_compatible'), undefined);
});

test('the accept button says what accepting does', () => {
  assert.equal(acceptLabel('keywords', 1), 'Track 1 keyword');
  assert.equal(acceptLabel('keywords', 3), 'Track 3 keywords');
  assert.equal(acceptLabel('listing_text', 2), 'Stage 2 texts');
  assert.equal(acceptLabel('reply_draft', 1), 'Save as reply draft');
});

test("a failed save names the setting the server refused, in the server's own validation words, and nothing else", () => {
  const refused = apiError(400, 'invalid_setting', {
    issues: [
      { path: 'baseUrl', message: 'Use https.' },
      { path: 'model', message: 'Too long.' },
      { path: 'x', message: 3 },
    ],
  });
  assert.equal(aiSaveMessage(refused), 'Use https. Too long.');
  assert.match(aiSaveMessage(apiError(400, 'invalid_setting', {})), /not valid/);
  assert.match(aiSaveMessage(apiError(400, 'invalid_secret')), /key cannot be used/);
  assert.equal(aiSaveMessage(apiError(403, 'forbidden')), 'Your role does not allow that.');
  assert.equal(aiSaveMessage(new Error('x')), 'The settings could not be saved. Try again.');
});

// ----- model discovery and the address of a local server

test('model request: only what the form holds; the typed key goes in the body for this call, a saved key is not sent', () => {
  const c = config();
  const form = formFromConfig(c);
  assert.deepEqual(modelsBody(form, c), { provider: 'anthropic' });
  assert.deepEqual(modelsBody({ ...form, apiKey: '  sk-typed  ' }, c), {
    provider: 'anthropic',
    apiKey: 'sk-typed',
  });
  assert.deepEqual(
    modelsBody(
      { ...form, provider: 'openai_compatible', baseUrl: ' http://localhost:11234/v1 ' },
      c,
    ),
    { provider: 'openai_compatible', baseUrl: 'http://localhost:11234/v1' },
  );
  assert.deepEqual(
    modelsBody({ ...form, baseUrl: 'https://ignored.example/v1' }, c),
    { provider: 'anthropic' },
    'a hosted provider has no address',
  );
});

test('the list loads by itself only when the form is ready: a key (typed or saved) for a hosted provider, a valid and allowed address for a compatible one', () => {
  const c = config({ server: { enabled: true, allowPrivateUrls: false } });
  const base = formFromConfig(c);
  const hosted = c.providers.find((p) => p.id === 'anthropic');
  const noKey = {
    ...c,
    providers: c.providers.map((p) =>
      p.id === 'anthropic' ? { ...p, credentialPresent: false } : p,
    ),
  };
  assert.equal(canAutoLoadModels(base, noKey), false, 'no key yet');
  assert.equal(
    canAutoLoadModels({ ...base, apiKey: 'sk-ant-api03-0123456789abcdefghijklmnop' }, noKey),
    true,
  );
  assert.equal(
    canAutoLoadModels(base, {
      ...c,
      providers: c.providers.map((p) =>
        p.id === 'anthropic' && hosted ? { ...p, credentialPresent: true } : p,
      ),
    }),
    true,
    'a saved key is enough',
  );
  const compat = { ...base, provider: 'openai_compatible' as const };
  assert.equal(canAutoLoadModels(compat, c), false, 'no address');
  assert.equal(canAutoLoadModels({ ...compat, baseUrl: 'not a url' }, c), false);
  assert.equal(canAutoLoadModels({ ...compat, baseUrl: 'https://models.example.com/v1' }, c), true);
  assert.equal(
    canAutoLoadModels({ ...compat, baseUrl: 'http://localhost:11234/v1' }, c),
    false,
    'this server refuses local addresses: no point in asking by itself',
  );
  assert.equal(
    canAutoLoadModels(
      { ...compat, baseUrl: 'http://localhost:11234/v1' },
      { ...c, server: { enabled: true, allowPrivateUrls: true } },
    ),
    true,
  );
});

test('the signature changes with the provider, the address and the key length, never holding the key', () => {
  const form = { provider: 'anthropic' as const, baseUrl: '', apiKey: '' };
  assert.equal(modelsSignature(form), modelsSignature({ ...form }));
  assert.notEqual(modelsSignature(form), modelsSignature({ ...form, apiKey: 'sk-secret' }));
  assert.ok(!modelsSignature({ ...form, apiKey: 'sk-secret' }).includes('sk-secret'));
  assert.notEqual(modelsSignature(form), modelsSignature({ ...form, provider: 'openai' }));
  assert.equal(
    modelsSignature({ ...form, baseUrl: ' https://a/v1 ' }),
    modelsSignature({ ...form, baseUrl: 'https://a/v1' }),
  );
});

test('the chosen model stays in the options even when it is not listed, and the notes are quiet and honest', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(modelOptions(list, 'b'), list);
  assert.deepEqual(
    modelOptions(list, 'zzz').map((m) => m.id),
    ['zzz', 'a', 'b'],
  );
  assert.deepEqual(modelOptions(list, ''), list);
  assert.equal(modelNotListed({ source: 'provider', models: list }, 'zzz'), true);
  assert.equal(modelNotListed({ source: 'provider', models: list }, 'a'), false);
  assert.equal(
    modelNotListed({ source: 'fallback', models: list }, 'zzz'),
    false,
    'a fixed list says nothing about what exists',
  );
  const anthropic = config().providers[0] ?? null;
  assert.equal(modelsNote({ source: 'provider', models: list }, anthropic), null);
  assert.match(
    modelsNote({ source: 'fallback', reason: 'list_unavailable', models: list }, anthropic) ?? '',
    /Could not read the list.*well known names/,
  );
  assert.match(
    modelsNote({ source: 'fallback', reason: 'list_unavailable', models: [] }, anthropic) ?? '',
    /Type the model name/,
  );
  assert.match(
    modelsNote({ source: 'fallback', reason: 'no_credential', models: list }, anthropic) ?? '',
    /Add a key/,
  );
  assert.equal(modelsNote(null, anthropic), null);
});

test('a local address is explained BEFORE it fails when this server only talks to public addresses', () => {
  for (const url of [
    'http://localhost:11234/v1',
    'http://127.0.0.1:1234/v1',
    'http://192.168.1.20:11434/v1',
    'http://10.0.0.5/v1',
    'https://172.20.0.3/v1',
    'http://host.docker.internal:11434/v1',
    'http://[::1]:11434/v1',
    'http://mybox.local/v1',
    'http://ollama:11434/v1',
  ]) {
    assert.equal(looksPrivateAddress(url), true, url);
    assert.equal(addressAdvice(url, false)?.text, ADDRESS_TEXTS.private_address_blocked, url);
  }
  for (const url of [
    'https://models.example.com/v1',
    'https://8.8.8.8/v1',
    'https://172.32.0.1/v1',
  ])
    assert.equal(looksPrivateAddress(url), false, url);
  assert.equal(addressAdvice('https://models.example.com/v1', false), null);
  assert.equal(addressAdvice('', false), null);
  assert.equal(
    addressAdvice('http://localhost:11234/v1', true),
    null,
    'allowed by the operator: nothing to say',
  );
  assert.equal(
    addressAdvice('http://192.168.1.20:11434/v1', true)?.text,
    ADDRESS_TEXTS.plain_http_not_allowed,
    'plain http is for localhost only, switch or not',
  );
  assert.equal(
    addressAdvice('http://example.com/v1', true)?.text,
    ADDRESS_TEXTS.plain_http_not_allowed,
  );
  assert.match(ADDRESS_TEXTS.private_address_blocked, /only talks to public addresses/);
  assert.match(
    ADDRESS_TEXTS.private_address_blocked,
    /MRM_AI_ALLOW_PRIVATE_URLS=true and restarts it/,
  );
  assert.match(ADDRESS_TEXTS.private_address_blocked, /Docker, localhost is the container/);
  assert.equal(needsV1Hint('http://localhost:11234'), true);
  assert.equal(needsV1Hint('http://localhost:11234/'), true);
  assert.equal(needsV1Hint('http://localhost:11234/v1'), false);
});

test('the fixed codes of a refused address turn into the same sentence on save, on test, on models and on a run', () => {
  const text = ADDRESS_TEXTS.private_address_blocked;
  assert.equal(
    aiSaveMessage(
      apiError(400, 'invalid_setting', {
        issues: [
          { path: 'baseUrl', message: 'RAW SERVER SENTENCE', code: 'private_address_blocked' },
        ],
      }),
    ),
    text,
  );
  assert.equal(
    aiErrorMessage(
      apiError(422, 'ai_not_configured', { reason: 'bad_url', hint: 'private_address_blocked' }),
    ),
    text,
  );
  assert.equal(
    aiErrorMessage(apiError(502, 'ai_unavailable', { reason: 'private_address_blocked' })),
    text,
  );
  assert.equal(
    aiTestText({ ok: false, kind: 'unavailable', reason: 'private_address_blocked' }).text,
    text,
  );
  assert.equal(
    aiErrorMessage(
      apiError(422, 'ai_not_configured', { reason: 'bad_url', hint: 'plain_http_not_allowed' }),
    ),
    ADDRESS_TEXTS.plain_http_not_allowed,
  );
  assert.match(
    aiTestText({ ok: false, kind: 'unavailable', reason: 'http_404' }).text,
    /not found/,
  );
  assert.equal(
    aiErrorMessage(apiError(422, 'ai_not_configured', { reason: 'no_model' })),
    'AI assistance is not set up yet. An admin can finish it in Settings.',
  );
});

test('an unusable answer says why, in fixed sentences', async () => {
  const { invalidOutputHint } = await import('./ai.ts');
  assert.match(invalidOutputHint('not_json'), /JSON/);
  assert.match(invalidOutputHint('truncated'), /cut off/);
  assert.equal(invalidOutputHint('whatever'), '');
});

test('the sample of an unusable answer is shown as short plain text, and only for an invalid output', () => {
  assert.equal(
    aiTestSample({
      ok: false,
      kind: 'invalid_output',
      sample: 'Sure!\n\n <b>here</b>\u0007 it is',
    }),
    'Sure! <b>here</b> it is',
  );
  assert.equal(
    Array.from(aiTestSample({ ok: false, kind: 'invalid_output', sample: 'x'.repeat(900) })).length,
    300,
  );
  assert.equal(aiTestSample({ ok: false, kind: 'auth', sample: 'not shown' }), '');
  assert.equal(aiTestSample({ ok: false, kind: 'invalid_output' }), '');
  assert.equal(aiTestSample({ ok: true, provider: 'openai_compatible', model: 'm' }), '');
});

test('isLocalAddress: this machine and private networks, not the internet', () => {
  for (const a of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080',
    'http://192.168.1.20:8000/v1',
    'http://10.0.0.5/v1',
    'http://172.20.0.2/v1',
    'http://studio.local:1234/v1',
    'http://host.docker.internal:11434/v1',
  ])
    assert.equal(isLocalAddress(a), true, a);
  for (const a of [
    'https://api.openai.com/v1',
    'http://172.32.0.1/v1',
    'http://8.8.8.8',
    'localhost',
    '',
    'https://example.com/localhost',
  ])
    assert.equal(isLocalAddress(a), false, a);
});
