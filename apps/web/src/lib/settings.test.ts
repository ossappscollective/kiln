import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  canEdit,
  checkLibreUrl,
  forgetTranslationConfig,
  formFromSettings,
  isDirty,
  KEYS,
  languageName,
  loadTranslationConfig,
  providerChoices,
  type SettingsForm,
  type SettingsResponse,
  settingsChanges,
  settingsErrorMessage,
  testOutcomeText,
  usageFraction,
  usageText,
  validateForm,
  lastRefreshText,
  syncIntervalLabel,
  syncIntervalOptions,
  syncOffText,
} from './settings.ts';

const defaults = {
  'reviews.lowRatingThreshold': 2,
  'translation.enabled': false,
  'translation.provider': 'google',
  'translation.targetLanguage': 'en',
  'translation.mode': 'on_demand',
  'translation.dailyCharBudget': 50000,
  'translation.libretranslate.url': '',
};
const ALL = Object.keys(defaults);

test('formFromSettings fills the form from the values and falls back to the defaults', () => {
  assert.deepEqual(formFromSettings(defaults), {
    lowRatingThreshold: '2',
    enabled: false,
    provider: 'google',
    targetLanguage: 'en',
    mode: 'on_demand',
    dailyCharBudget: '50000',
    libreUrl: '',
    stalledAfterHours: '6',
    stalledRepeatHours: '24',
    unansweredReminderHours: '0',
    unansweredMaxRating: '5',
    analyticsEnabled: false,
    analyticsVendorNumber: '',
    analyticsBucketId: '',
    syncEnabled: true,
    syncIntervalMinutes: '30',
  });
  const odd = formFromSettings({ 'translation.provider': 'nope', 'translation.mode': 'nope' });
  assert.equal(odd.provider, 'google');
  assert.equal(odd.mode, 'on_demand');
});

test('validateForm: threshold, language, budget and address', () => {
  const form = formFromSettings(defaults);
  assert.deepEqual(validateForm(form), {});
  for (const bad of ['0', '5', '2.5', '', 'two', '-1']) {
    assert.ok(validateForm({ ...form, lowRatingThreshold: bad }).lowRatingThreshold, bad);
  }
  for (const good of ['1', '4', ' 3 '])
    assert.equal(
      validateForm({ ...form, lowRatingThreshold: good }).lowRatingThreshold,
      undefined,
      good,
    );
  assert.ok(validateForm({ ...form, targetLanguage: 'not a tag' }).targetLanguage);
  assert.equal(validateForm({ ...form, targetLanguage: 'pt_BR' }).targetLanguage, undefined);
  assert.ok(validateForm({ ...form, dailyCharBudget: '-5' }).dailyCharBudget);
  assert.ok(validateForm({ ...form, dailyCharBudget: '1000000000000' }).dailyCharBudget);
  assert.equal(validateForm({ ...form, dailyCharBudget: '0' }).dailyCharBudget, undefined);
  // LibreTranslate with translation on needs an address.
  assert.ok(validateForm({ ...form, provider: 'libretranslate', enabled: true }).libreUrl);
  assert.equal(
    validateForm({ ...form, provider: 'libretranslate', enabled: false }).libreUrl,
    undefined,
  );
});

test('analytics settings: on only when the value is true, ids are checked and saved in their clean form, and only those who may write them send them', () => {
  const saved = {
    ...defaults,
    'analytics.enabled': false,
    'analytics.appleVendorNumber': '',
    'analytics.playBucketId': '',
  };
  const all = [
    ...ALL,
    'analytics.enabled',
    'analytics.appleVendorNumber',
    'analytics.playBucketId',
  ];
  assert.equal(formFromSettings({ 'analytics.enabled': true }).analyticsEnabled, true);
  assert.equal(formFromSettings({ 'analytics.enabled': 'true' }).analyticsEnabled, false);
  const form = formFromSettings(saved);
  assert.deepEqual(validateForm(form), {});
  assert.ok(validateForm({ ...form, analyticsVendorNumber: 'abc' }).analyticsVendorNumber);
  assert.ok(validateForm({ ...form, analyticsBucketId: 'not a bucket!' }).analyticsBucketId);
  assert.equal(
    validateForm({ ...form, analyticsVendorNumber: '12345678' }).analyticsVendorNumber,
    undefined,
  );
  assert.equal(
    validateForm({ ...form, analyticsBucketId: 'pubsite_prod_rev_01234567890123456789' })
      .analyticsBucketId,
    undefined,
  );
  const on = { ...form, analyticsEnabled: true, analyticsVendorNumber: ' 12345678 ' };
  assert.deepEqual(settingsChanges(saved, on, all), {
    'analytics.enabled': true,
    'analytics.appleVendorNumber': '12345678',
  });
  // without analytics.manage nothing about analytics is sent
  assert.deepEqual(settingsChanges(saved, on, ALL), {});
  assert.deepEqual(settingsChanges(saved, form, all), {});
});

test('checkLibreUrl: https, no credentials, no query; http only on this machine', () => {
  assert.equal(checkLibreUrl(''), undefined);
  assert.equal(checkLibreUrl('https://translate.example.com'), undefined);
  assert.equal(checkLibreUrl('https://translate.example.com:5000/api'), undefined);
  assert.equal(checkLibreUrl('http://localhost:5000'), undefined);
  assert.equal(checkLibreUrl('http://127.0.0.1:5000'), undefined);
  for (const bad of [
    'translate.example.com',
    'http://translate.example.com',
    'ftp://x.example.com',
    'https://user:pw@x.example.com',
    'https://x.example.com/?key=1',
    'https://x.example.com/#a',
  ]) {
    assert.ok(checkLibreUrl(bad), bad);
  }
});

test('settingsChanges: only keys that differ and that the caller may write', () => {
  const form: SettingsForm = {
    ...formFromSettings(defaults),
    lowRatingThreshold: '3',
    enabled: true,
    targetLanguage: 'pt_br',
  };
  assert.deepEqual(settingsChanges(defaults, form, ALL), {
    'reviews.lowRatingThreshold': 3,
    'translation.enabled': true,
    'translation.targetLanguage': 'pt-BR',
  });
  assert.deepEqual(settingsChanges(defaults, form, ['reviews.lowRatingThreshold']), {
    'reviews.lowRatingThreshold': 3,
  });
  assert.deepEqual(settingsChanges(defaults, form, []), {});
  assert.deepEqual(settingsChanges(defaults, formFromSettings(defaults), ALL), {});
  assert.equal(isDirty(defaults, form, ALL), true);
  assert.equal(isDirty(defaults, form, []), false);
  assert.equal(canEdit(ALL, KEYS.mode), true);
  assert.equal(canEdit([], KEYS.mode), false);
});

test('providers: Google is the default and every choice states who receives the text', () => {
  assert.deepEqual(
    providerChoices.map((p) => p.id),
    ['google', 'deepl', 'azure', 'libretranslate'],
  );
  assert.deepEqual(
    providerChoices.filter((p) => p.isDefault).map((p) => p.id),
    ['google'],
  );
  for (const choice of providerChoices) assert.ok(choice.privacy.length > 20, choice.id);
  assert.equal(providerChoices.find((p) => p.id === 'libretranslate')?.needsUrl, true);
  assert.equal(providerChoices.find((p) => p.id === 'libretranslate')?.credentialRequired, false);
  assert.equal(providerChoices.find((p) => p.id === 'google')?.credentialKind, 'translate_google');
});

test('languageName knows common codes and falls back to the code', () => {
  assert.equal(languageName('de'), 'German');
  assert.equal(languageName('pt_BR'), 'Portuguese (Brazil)');
  assert.equal(languageName('de-AT'), 'German');
  assert.equal(languageName('xx'), 'xx');
  assert.equal(languageName(null), 'another language');
});

test('usage text and fraction', () => {
  assert.equal(
    usageText({ day: '2026-06-10', used: 12300, budget: 50000 }),
    '12,300 of 50,000 characters used today (UTC), 25%.',
  );
  assert.match(usageText({ day: 'd', used: 5, budget: 0 }), /no daily limit/);
  assert.equal(usageFraction({ day: 'd', used: 25, budget: 50 }), 0.5);
  assert.equal(usageFraction({ day: 'd', used: 99, budget: 50 }), 1);
  assert.equal(usageFraction({ day: 'd', used: 5, budget: 0 }), null);
});

test('error and test messages are plain sentences', () => {
  assert.match(
    settingsErrorMessage(new ApiError(403, 'forbidden', 'x'), 'save'),
    /owner or an admin/,
  );
  assert.match(
    settingsErrorMessage(new ApiError(403, 'forbidden', 'x'), 'load'),
    /does not include/,
  );
  const invalid = new ApiError(400, 'invalid_setting', 'A setting is not valid.', undefined, {
    issues: [{ path: 'translation.libretranslate.url', message: 'Use https.' }],
  });
  assert.equal(settingsErrorMessage(invalid, 'save'), 'translation.libretranslate.url: Use https.');
  assert.equal(settingsErrorMessage(new Error('x')), 'Something went wrong. Try again.');
  assert.match(testOutcomeText({ ok: true, message: 'x' }), /translated a test word/);
  assert.equal(
    testOutcomeText({ ok: false, message: 'The key was refused.' }),
    'The key was refused.',
  );
});

test('loadTranslationConfig asks once per workspace for 30 seconds, and null when settings are not readable', async () => {
  forgetTranslationConfig();
  let calls = 0;
  const settings = (over: Record<string, unknown> = {}) =>
    ({ values: { ...defaults, ...over } }) as unknown as SettingsResponse;
  const api = {
    workspaceSettings: async () => (
      calls++, settings({ 'translation.enabled': true, 'translation.targetLanguage': 'de' })
    ),
  };
  const [a, b] = await Promise.all([
    loadTranslationConfig(api, 'w1', 1000),
    loadTranslationConfig(api, 'w1', 1001),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { enabled: true, mode: 'on_demand', target: 'de', provider: 'google' });
  assert.equal(a, b);
  await loadTranslationConfig(api, 'w1', 1000 + 29_000);
  assert.equal(calls, 1);
  await loadTranslationConfig(api, 'w1', 1000 + 31_000);
  assert.equal(calls, 2);
  await loadTranslationConfig(api, 'w2', 1000);
  assert.equal(calls, 3);
  forgetTranslationConfig('w1');
  await loadTranslationConfig(api, 'w1', 1000);
  assert.equal(calls, 4);
  const denied = {
    workspaceSettings: async () => {
      throw new ApiError(403, 'forbidden', 'no');
    },
  };
  assert.equal(await loadTranslationConfig(denied, 'w3', 1000), null);
  forgetTranslationConfig();
});

test('the release and reminder settings: defaults, limits and the keys they are saved under', () => {
  const saved = {
    ...defaults,
    'release.stalledAfterHours': 6,
    'release.stalledRepeatHours': 24,
    'reviews.unansweredReminderHours': 0,
    'reviews.unansweredMaxRating': 5,
  };
  const form = formFromSettings(saved);
  assert.deepEqual(validateForm(form), {});
  for (const bad of ['', '-1', '721', '1.5', 'six']) {
    assert.ok(validateForm({ ...form, stalledAfterHours: bad }).stalledAfterHours, bad);
    assert.ok(validateForm({ ...form, stalledRepeatHours: bad }).stalledRepeatHours, bad);
    assert.ok(validateForm({ ...form, unansweredReminderHours: bad }).unansweredReminderHours, bad);
  }
  for (const good of ['0', '720', ' 12 '])
    assert.equal(
      validateForm({ ...form, stalledAfterHours: good }).stalledAfterHours,
      undefined,
      good,
    );
  for (const bad of ['0', '6', '', '2.5'])
    assert.ok(validateForm({ ...form, unansweredMaxRating: bad }).unansweredMaxRating, bad);
  const changed = {
    ...form,
    stalledAfterHours: '12',
    unansweredReminderHours: '24',
    unansweredMaxRating: '2',
  };
  assert.deepEqual(settingsChanges(saved, changed, Object.keys(saved)), {
    'release.stalledAfterHours': 12,
    'reviews.unansweredReminderHours': 24,
    'reviews.unansweredMaxRating': 2,
  });
  assert.deepEqual(settingsChanges(saved, changed, ['reviews.unansweredMaxRating']), {
    'reviews.unansweredMaxRating': 2,
  });
  assert.equal(KEYS.stalledRepeatHours, 'release.stalledRepeatHours');
});

test('the store refresh settings: form, limits, changes and the sentences on the card', () => {
  const saved = { ...defaults, 'sync.enabled': true, 'sync.intervalMinutes': 30 };
  const form = formFromSettings(saved);
  assert.equal(form.syncEnabled, true);
  assert.equal(form.syncIntervalMinutes, '30');
  assert.equal(formFromSettings({ 'sync.enabled': false }).syncEnabled, false);
  assert.deepEqual(validateForm(form), {});
  for (const bad of ['', '4', '10081', '1.5', 'daily', '-15']) {
    assert.ok(validateForm({ ...form, syncIntervalMinutes: bad }).syncIntervalMinutes, bad);
  }
  assert.equal(KEYS.syncEnabled, 'sync.enabled');
  assert.equal(KEYS.syncIntervalMinutes, 'sync.intervalMinutes');
  // Only what changed is sent, and only keys the caller may write.
  const all = [...ALL, 'sync.enabled', 'sync.intervalMinutes'];
  assert.deepEqual(settingsChanges(saved, { ...form, syncEnabled: false, syncIntervalMinutes: '360' }, all), {
    'sync.enabled': false,
    'sync.intervalMinutes': 360,
  });
  assert.deepEqual(settingsChanges(saved, { ...form, syncEnabled: false }, ['sync.intervalMinutes']), {});

  assert.deepEqual(
    [15, 30, 60, 360, 1440, 45, 2880].map(syncIntervalLabel),
    ['15 minutes', '30 minutes', '1 hour', '6 hours', 'Daily', '45 minutes', '2 days'],
  );
  assert.deepEqual(syncIntervalOptions(30).map((o) => o.value), [15, 30, 60, 360, 1440]);
  assert.deepEqual(syncIntervalOptions(45).map((o) => o.value), [15, 30, 45, 60, 360, 1440], 'the server\'s own value stays selectable');

  const now = 1_800_000_000_000;
  const sync = { serverMinutes: 30, enabled: true, intervalMinutes: 30, running: true, lastScheduledAt: now - 5 * 60_000 };
  assert.equal(lastRefreshText(sync, now), 'The last scheduled refresh ran 5 minutes ago.');
  assert.equal(lastRefreshText({ ...sync, lastScheduledAt: null }, now), 'No scheduled refresh has run yet.');
  assert.equal(lastRefreshText(undefined, now), '');
  assert.equal(syncOffText(sync), '');
  assert.match(syncOffText({ ...sync, running: false, off: 'server_off' }), /whole server/);
  assert.match(syncOffText({ ...sync, running: false, off: 'workspace_off' }), /off for this workspace/);
});
