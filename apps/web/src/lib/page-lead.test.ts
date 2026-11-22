import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildsLead,
  keywordsLead,
  needsAnswerText,
  reviewsLead,
  settingsLead,
} from './page-lead.ts';

test('needsAnswerText says what the person has to do', () => {
  assert.equal(needsAnswerText('5 unanswered, oldest 3 d'), '5 reviews need an answer, oldest 3 d');
  assert.equal(needsAnswerText('1 unanswered (1 star)'), '1 review needs an answer (1 star)');
  assert.equal(needsAnswerText('something else'), 'something else');
});

test('reviewsLead: the first action follows the state', () => {
  assert.equal(reviewsLead({ loaded: false, stored: 0, chip: null }).primary, 'none');
  assert.equal(reviewsLead({ loaded: true, stored: 0, chip: null }).primary, 'none');
  const open = reviewsLead({ loaded: true, stored: 40, chip: { text: '2 unanswered' } });
  assert.deepEqual(open, { headline: '2 reviews need an answer', tone: 'warn', primary: 'show' });
  const done = reviewsLead({ loaded: true, stored: 40, chip: null });
  assert.deepEqual(done, {
    headline: 'No review is waiting for an answer',
    tone: 'ok',
    primary: 'read',
  });
});

test('buildsLead counts builds and the ones without a run', () => {
  assert.equal(buildsLead(0, 0).headline, 'No builds yet');
  assert.deepEqual(buildsLead(1, 0), { headline: '1 build, each matched to a CI run', tone: 'ok' });
  assert.deepEqual(buildsLead(12, 3), { headline: '12 builds, 3 without a CI run', tone: 'info' });
});

test('keywordsLead counts the top 10 and points at unchecked words', () => {
  assert.equal(keywordsLead([]).headline, 'No keywords tracked yet');
  const some = keywordsLead([
    { state: 'ranked', rank: 3 },
    { state: 'ranked', rank: 40 },
    { state: null, rank: null },
  ]);
  assert.equal(some.headline, '3 keywords tracked, 1 in the top 10');
  assert.equal(some.tone, 'info');
  assert.match(some.hint, /1 not checked yet/);
  const done = keywordsLead([{ state: 'ranked', rank: 1 }]);
  assert.equal(done.headline, '1 keyword tracked, 1 in the top 10');
  assert.equal(done.tone, 'neutral');
});

test('settingsLead: a failing sync first, then a record never synced, then all connected', () => {
  const ok = { lastSyncError: null, lastSyncedAt: 1 };
  assert.equal(settingsLead([{ platform: 'ios', ...ok }]).tone, 'ok');
  const failing = settingsLead([
    { platform: 'ios', lastSyncError: 'bad key', lastSyncedAt: 1 },
    { platform: 'android', lastSyncError: null, lastSyncedAt: null },
  ]);
  assert.equal(failing.headline, 'The last sync failed for iOS');
  assert.equal(failing.tone, 'warn');
  const never = settingsLead([
    { platform: 'ios', ...ok },
    { platform: 'android', lastSyncError: null, lastSyncedAt: null },
  ]);
  assert.deepEqual([never.headline, never.tone], ['Android has not synced yet', 'info']);
  assert.equal(
    settingsLead([
      { platform: 'ios', lastSyncError: 'x', lastSyncedAt: 1 },
      { platform: 'macos', lastSyncError: 'x', lastSyncedAt: 1 },
      { platform: 'android', lastSyncError: 'x', lastSyncedAt: 1 },
    ]).headline,
    'The last sync failed for iOS, macOS, and Android',
  );
});

test('the lead words, the publish title and the shortcut labels follow the language', async () => {
  const { useLocale } = await import('./i18n/test-setup.ts');
  const { shortcutRegistry, shortcutGroupLabel } = await import('./shortcuts.ts');
  const { publishTitle } = await import('./readability.ts');
  useLocale('fr');
  try {
    assert.equal(
      needsAnswerText('3 sans réponse, le plus ancien : 2 j'),
      '3 avis attendent une réponse, le plus ancien : 2 j',
    );
    assert.equal(needsAnswerText('5 unanswered'), '5 unanswered', 'text of another language is kept');
    assert.equal(buildsLead(0, 0).headline, 'Aucun build pour l’instant');
    assert.equal(buildsLead(12, 3).headline, '12 builds, dont 3 sans exécution CI');
    assert.equal(keywordsLead([]).headline, 'Aucun mot-clé suivi pour l’instant');
    assert.equal(settingsLead([{ platform: 'ios', lastSyncError: null, lastSyncedAt: null }]).headline, 'iOS n’a pas encore été synchronisé');
    const registry = shortcutRegistry('workspace');
    assert.ok(registry.some((s) => s.label === 'Toutes les applications'));
    assert.equal(shortcutGroupLabel('Go to'), 'Aller à');
    assert.equal(publishTitle({ steps: [] }, 'Google Play'), 'Publier sur Google Play');
  } finally {
    useLocale('en');
  }
});
