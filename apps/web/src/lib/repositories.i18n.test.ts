import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testStatus } from './credentials.ts';
import { useLocale } from './i18n/test-setup.ts';
import {
  actorLabel,
  changeSetStatusInfo,
  fieldUsage,
  filesChangedLabel,
  localReadSummary,
  localRootsHint,
  platformsSummary,
  suggestSummary,
} from './repositories.ts';

afterEach(() => useLocale('en'));

test('counts and plurals follow the active language', () => {
  useLocale('fr');
  assert.equal(filesChangedLabel(1), '1 fichier');
  assert.equal(filesChangedLabel(3), '3 fichiers');
  assert.equal(
    fieldUsage({ maxLength: 30, unit: 'characters' }, 'Hello').text,
    '5 / 30 caractères',
  );
  assert.equal(fieldUsage({ unit: 'bytes' }, 'abc').text, '3 octets');
  useLocale('de');
  assert.equal(filesChangedLabel(2), '2 Dateien');
  assert.equal(
    suggestSummary([{ store: 'app_store', field: 'name', before: 'a', after: 'b' }]),
    '1 Eintragsfeld aktualisieren',
  );
});

test('every branch of the read summary is a whole sentence in each language', () => {
  const sha = 'abc1234def5678';
  for (const code of ['en', 'fr', 'es', 'de']) {
    useLocale(code);
    const inputs = [
      { branch: 'main', sha },
      { branch: 'main', sha: null },
      { branch: 'main', sha, dirtyCount: null },
      { branch: 'main', sha, dirtyCount: 0, checkedOutBranch: 'main' },
      { branch: 'main', sha, dirtyCount: 1, checkedOutBranch: 'main' },
      { branch: 'main', sha, dirtyCount: 4, checkedOutBranch: 'main' },
      { branch: 'main', sha, dirtyCount: 4, checkedOutBranch: 'dev' },
      { branch: 'main', sha: null, dirtyCount: 4, checkedOutBranch: null },
    ];
    for (const input of inputs) {
      const text = localReadSummary(input);
      assert.ok(!text.includes('repositories:'), `${code}: ${text}`);
      assert.ok(!text.includes('{{'), `${code}: ${text}`);
      assert.ok(text.includes('main'), `${code}: ${text}`);
    }
  }
  useLocale('fr');
  assert.match(
    localReadSummary({ branch: 'main', sha, dirtyCount: 3, checkedOutBranch: 'main' }),
    /3 modifications non validées/,
  );
});

test('labels, statuses and lists come from the catalogs', () => {
  useLocale('es');
  assert.equal(changeSetStatusInfo('draft').label, 'Borrador');
  assert.equal(actorLabel({ type: 'system', id: 's' }, 'u'), 'El sistema');
  assert.match(localRootsHint({ roots: ['/a', '/b'] }), /una de las carpetas permitidas: \/a, \/b/);
  const detection = {
    platforms: ['ios', 'android'],
    platformsInferred: [],
  } as unknown as Parameters<typeof platformsSummary>[0];
  assert.equal(platformsSummary(detection), 'iOS y Android');
});

test('the credential status words and tooltips are translated', () => {
  useLocale('de');
  assert.equal(testStatus(null).label, 'Nie getestet');
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const status = testStatus({ at: now - 5 * 60_000, ok: false, message: 'Abgelehnt.' }, now);
  assert.equal(status.label, 'Fehlgeschlagen');
  assert.match(status.title, /^Fehlgeschlagen, getestet am .*\. Abgelehnt\.$/);
  assert.equal(status.when, 'vor 5 Minuten');
});
