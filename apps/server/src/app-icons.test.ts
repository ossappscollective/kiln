import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IconRow } from './services/app-icon-store.ts';
import {
  EMPTY_BACKOFF_MS,
  ICON_MAX_BYTES,
  REMOTE_RECHECK_REPO_MS,
  REMOTE_REFRESH_MS,
  REPO_RECHECK_MS,
  checkIconBytes,
  failureBackoffMs,
  lookDue,
  pickRepositoryIcon,
} from './services/app-icons.ts';
import { isPlainRelativePath, matchesEtag, safeImageHeaders } from './routes/assets.ts';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const png = (w: number, h: number, pad = 0) =>
  Uint8Array.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(pad).fill(0)]);

type A = Parameters<typeof pickRepositoryIcon>[0]['assets'][number];
const asset = (patch: Partial<A>): A => ({
  path: 'x.png',
  locale: 'en-US',
  kind: 'icon',
  device: null,
  deviceLabel: '',
  order: 1,
  bytes: 1000,
  width: 512,
  height: 512,
  format: 'png',
  hasAlpha: true,
  oid: 'a'.repeat(40),
  read: 'read',
  origin: 'store',
  ...patch,
});

test('the icon of the repository: store icon before project icon, en-US first, then the larger', () => {
  const pick = (assets: A[]) => pickRepositoryIcon({ assets })?.path;
  assert.equal(pick([]), undefined);
  assert.equal(pick([asset({ path: 'app', kind: 'app_icon', origin: 'project', width: 1024, height: 1024 }), asset({ path: 'store' })]), 'store');
  assert.equal(pick([asset({ path: 'de', locale: 'de-DE', width: 1024, height: 1024 }), asset({ path: 'en' })]), 'en');
  assert.equal(pick([asset({ path: 'small', width: 128, height: 128 }), asset({ path: 'large', width: 512, height: 512 })]), 'large');
  assert.equal(pick([asset({ path: 'b' }), asset({ path: 'a' })]), 'a', 'a tie is broken by path');
  assert.equal(pick([asset({ path: 'app', kind: 'app_icon', origin: 'project' })]), 'app');
});

test('files that cannot be an icon are never picked', () => {
  const none = (patch: Partial<A>) => pickRepositoryIcon({ assets: [asset(patch)] });
  assert.equal(none({ kind: 'screenshot' }), undefined);
  assert.equal(none({ kind: 'feature_graphic' }), undefined);
  assert.equal(none({ read: 'unreadable' }), undefined);
  assert.equal(none({ read: 'not_read' }), undefined);
  assert.equal(none({ oid: null }), undefined);
  assert.equal(none({ width: 512, height: 500 }), undefined, 'not square');
  assert.equal(none({ width: 32, height: 32 }), undefined, 'too small');
  assert.equal(none({ format: 'gif' }), undefined);
  assert.equal(none({ format: 'video' }), undefined);
  assert.equal(none({ format: null }), undefined);
  assert.equal(none({ bytes: ICON_MAX_BYTES + 1 }), undefined);
  assert.equal(none({ bytes: null }), undefined);
  assert.notEqual(none({ bytes: ICON_MAX_BYTES }), undefined);
  assert.notEqual(none({ format: 'jpeg' }), undefined);
  assert.notEqual(none({ format: 'webp' }), undefined);
});

test('icon bytes: sniffed type, square, big enough, small enough', () => {
  assert.deepEqual(checkIconBytes(png(512, 512)), { ok: true, image: { mediaType: 'image/png', width: 512, height: 512 } });
  const refused = (bytes: Uint8Array, pattern: RegExp) => {
    const res = checkIconBytes(bytes);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, pattern);
  };
  refused(new Uint8Array(0), /empty/);
  refused(png(512, 512, ICON_MAX_BYTES), /256 KB/);
  refused(png(512, 400), /square/);
  refused(png(32, 32), /smaller/);
  refused(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), /not a readable image/);
  refused(new TextEncoder().encode('<!doctype html>'), /not a readable image/);
  refused(Uint8Array.from([...text('GIF89a'), 0, 2, 0, 2, 0, 0, 0]), /gif/);
  refused(png(512, 512).subarray(0, 20), /not a readable image/);
});

const row = (patch: Partial<IconRow> = {}): IconRow => ({
  appId: 'a',
  workspaceId: 'w',
  source: 'repository',
  sourceId: 's',
  mediaType: 'image/png',
  data: new Uint8Array([1]),
  size: 1,
  width: 512,
  height: 512,
  etag: 'e',
  fetchedAt: 1000,
  checkedAt: 1000,
  failures: 0,
  backoffUntil: null,
  lastError: null,
  ...patch,
});

test('when to look again', () => {
  const t0 = 1_000_000;
  const at = (r: IconRow | undefined, dt: number) => lookDue(r, t0 + dt);
  assert.equal(lookDue(undefined, t0), true, 'never looked');
  // A repository icon: after the recheck interval.
  const repo = row({ checkedAt: t0, fetchedAt: t0 });
  assert.equal(at(repo, REPO_RECHECK_MS - 1), false);
  assert.equal(at(repo, REPO_RECHECK_MS), true);
  // A remote icon: the repository daily, the remote after 7 days.
  const remote = row({ source: 'app_store', checkedAt: t0, fetchedAt: t0 });
  assert.equal(at(remote, REMOTE_RECHECK_REPO_MS - 1), false);
  assert.equal(at(remote, REMOTE_RECHECK_REPO_MS), true);
  const recheckedButOld = row({ source: 'app_store', checkedAt: t0 + REMOTE_REFRESH_MS - 10, fetchedAt: t0 });
  assert.equal(at(recheckedButOld, REMOTE_REFRESH_MS), true, 'seven days after the fetch');
  // Nothing found: after the empty back-off. A back-off is never overridden.
  const empty = row({ source: null, data: null, checkedAt: t0, backoffUntil: t0 + EMPTY_BACKOFF_MS });
  assert.equal(at(empty, EMPTY_BACKOFF_MS - 1), false);
  assert.equal(at(empty, EMPTY_BACKOFF_MS), true);
  const failing = row({ checkedAt: t0 - REPO_RECHECK_MS * 5, backoffUntil: t0 + 100 });
  assert.equal(at(failing, 50), false, 'in back-off even though a look is overdue');
  assert.equal(at(failing, 100), true);
});

test('the failure back-off doubles from 15 minutes to a day', () => {
  const minute = 60_000;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(failureBackoffMs), [15, 30, 60, 120, 240, 480, 960, 1440, 1440].map((m) => m * minute));
  assert.equal(failureBackoffMs(0), 15 * minute);
});

test('paths and entity tags of the file routes', () => {
  for (const ok of ['a.png', 'fastlane/metadata/en-US/images/icon.png', 'a b/c.png', 'ü/é.png']) assert.equal(isPlainRelativePath(ok), true, ok);
  for (const bad of ['', '/a', '../a', 'a/..', 'a/../b', './a', 'a/./b', 'a//b', 'a/', 'a\\b', 'a\0b', 'x'.repeat(1025)]) assert.equal(isPlainRelativePath(bad), false, JSON.stringify(bad));
  assert.equal(matchesEtag('"abc"', '"abc"'), true);
  assert.equal(matchesEtag('W/"abc"', '"abc"'), true);
  assert.equal(matchesEtag('"x", "abc"', '"abc"'), true);
  assert.equal(matchesEtag('*', '"abc"'), true);
  assert.equal(matchesEtag('"abd"', '"abc"'), false);
  assert.equal(matchesEtag(undefined, '"abc"'), false);
  assert.equal(matchesEtag('', '"abc"'), false);
});

test('the safe image headers', () => {
  const h = safeImageHeaders('image/png', '"e"', 12, 'private, max-age=60');
  assert.equal(h['Content-Type'], 'image/png');
  assert.equal(h['Content-Disposition'], 'inline');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Content-Security-Policy'], "default-src 'none'; sandbox");
  assert.equal(h['Content-Length'], '12');
  assert.equal(h.ETag, '"e"');
  assert.equal(h['Cache-Control'], 'private, max-age=60');
});
