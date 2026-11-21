import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CloneView,
  cloneSummary,
  formatBytes,
  limitsSentence,
  purgeMessage,
} from './clone-upkeep.ts';

test('formatBytes uses binary multiples with one decimal under ten', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(formatBytes(5 * 1024 ** 4), '5.0 TB');
  assert.equal(formatBytes(3 * 1024, true), 'at least 3.0 KB');
  assert.equal(formatBytes(-5), '0 B');
});

test('the limits sentence says what the server does, or that nothing is removed', () => {
  assert.equal(
    limitsSentence({ idleDays: 0, maxBytes: 0 }),
    'Clones are kept until the repository is disconnected.',
  );
  assert.equal(
    limitsSentence({ idleDays: 30, maxBytes: 2 * 1024 ** 3 }),
    'Clones are removed after 30 days without use; the least recently used are removed above 2.0 GB in total. A removed clone is fetched again by the next read.',
  );
  assert.match(limitsSentence({ idleDays: 1, maxBytes: 0 }), /after 1 day without use/);
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
  assert.match(cloneSummary({ enabled: false, clone: null }), /KILN_READS=api/);
  assert.match(cloneSummary({ enabled: true, clone: null }), /No clone on disk/);
  assert.equal(cloneSummary({ enabled: true, clone }), '4.0 KB on the server.');
  assert.equal(
    cloneSummary({ enabled: true, clone: { ...clone, sizeIsLowerBound: true } }),
    'at least 4.0 KB on the server.',
  );
  assert.equal(purgeMessage({ removed: 0, freedBytes: 0 }), 'There was no clone to remove.');
  assert.equal(
    purgeMessage({ removed: 2, freedBytes: 2048 }),
    'Removed the clone and freed 2.0 KB. The next read fetches it again.',
  );
});
