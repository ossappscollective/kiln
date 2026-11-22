import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import {
  type CloneView,
  cloneSummary,
  formatBytes,
  limitsSentence,
  purgeMessage,
} from './clone-upkeep.ts';

test('formatBytes uses binary multiples with one decimal under ten', () => {
  useLocale('en');
  assert.equal(formatBytes(0), '0 byte');
  assert.equal(formatBytes(1023), '1,023 byte');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2 GB');
  assert.equal(formatBytes(-5), '0 byte');
});

test('the limits sentence says what the server does, or that nothing is removed', () => {
  useLocale('en');
  assert.equal(
    limitsSentence({ idleDays: 0, maxBytes: 0 }),
    'Clones are kept until the repository is disconnected.',
  );
  assert.equal(
    limitsSentence({ idleDays: 30, maxBytes: 2 * 1024 ** 3 }),
    'Clones are removed after 30 days without use; the least recently used are removed above 2 GB in total. A removed clone is fetched again by the next read.',
  );
  assert.match(limitsSentence({ idleDays: 1, maxBytes: 0 }), /after 1 day without use/);
  assert.match(limitsSentence({ idleDays: 0, maxBytes: 1024 ** 3 }), /above 1 GB in total/);
});

test('the limits sentence follows the active language', () => {
  useLocale('fr');
  assert.match(limitsSentence({ idleDays: 3, maxBytes: 0 }), /après 3 jours sans utilisation/);
  assert.match(purgeMessage({ removed: 1, freedBytes: 1024 ** 2 }), /Mo libérés/);
});

const clone: CloneView = {
  repositoryId: 'r',
  name: 'a/b',
  kind: 'github',
  bytes: 4096,
  sizeIsLowerBound: false,
  lastUsedAt: 1,
  createdAt: 1,
  inUse: false,
};

test('the summary line and the result of freeing space', () => {
  useLocale('en');
  assert.match(cloneSummary({ enabled: false, clone: null }), /KILN_READS=api/);
  assert.match(cloneSummary({ enabled: true, clone: null }), /No clone on disk/);
  assert.equal(cloneSummary({ enabled: true, clone }), '4 kB on the server.');
  assert.equal(
    cloneSummary({ enabled: true, clone: { ...clone, sizeIsLowerBound: true } }),
    'At least 4 kB on the server.',
  );
  assert.equal(purgeMessage({ removed: 0, freedBytes: 0 }), 'There was no clone to remove.');
  assert.equal(
    purgeMessage({ removed: 2, freedBytes: 2048 }),
    'Removed the clone and freed 2 kB. The next read fetches it again.',
  );
});
