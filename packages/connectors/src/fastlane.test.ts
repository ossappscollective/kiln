import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AppStoreListing, type Listing, type PlayListing, validateListing } from '@mrm/core';
import {
  type FileMap,
  listingChangeSet,
  listingFilePaths,
  loadListing,
  readListing,
} from './fastlane.ts';

const apple = (listing: Listing): AppStoreListing => {
  assert.ok(listing.appStore);
  return listing.appStore;
};
const play = (listing: Listing): PlayListing => {
  assert.ok(listing.googlePlay);
  return listing.googlePlay;
};
const at = <T>(record: Record<string, T>, key: string): T => {
  const value = record[key];
  assert.ok(value !== undefined, `${key} is missing`);
  return value;
};

const IOS = 'fastlane/metadata';
const ANDROID = 'fastlane/metadata/android';

const repoFiles = (): FileMap => ({
  [`${IOS}/copyright.txt`]: '2026 Example, Inc.\n',
  [`${IOS}/en-US/name.txt`]: 'Trail Notes\n',
  [`${IOS}/en-US/subtitle.txt`]: 'Hike, log, share\n',
  [`${IOS}/en-US/description.txt`]: 'Log every hike.\n\nShare it with friends.\n',
  [`${IOS}/en-US/keywords.txt`]: 'hiking,trail,gps\n',
  [`${IOS}/en-US/support_url.txt`]: 'https://example.com/support\n',
  [`${IOS}/en-US/privacy_url.txt`]: 'https://example.com/privacy\n',
  [`${IOS}/de-DE/name.txt`]: 'Wegnotizen\n',
  [`${IOS}/review_information/notes.txt`]: 'Use the demo account.\n',
  [`${IOS}/android/ignored.txt`]: 'not ours\n',
  [`${ANDROID}/en-US/title.txt`]: 'Trail Notes\n',
  [`${ANDROID}/en-US/short_description.txt`]: 'Log every hike.\n',
  [`${ANDROID}/en-US/full_description.txt`]: 'Log every hike and share it.\n',
  [`${ANDROID}/en-US/changelogs/42.txt`]: 'Fixes.\n',
  [`${ANDROID}/en-US/changelogs/default.txt`]: 'Improvements.\n',
  'fastlane/Fastfile': 'default_platform(:ios)\n',
  'fastlane/screenshots/en-US/1.png': 'binary',
});

test('reads both stores into the normalized model and drops one trailing newline', () => {
  const snap = readListing(repoFiles());
  assert.deepEqual(snap.roots, { appStore: IOS, googlePlay: ANDROID });
  assert.deepEqual(snap.found, { appStore: true, googlePlay: true });
  assert.equal(snap.listing.appStore?.copyright, '2026 Example, Inc.');
  assert.equal(
    snap.listing.appStore?.locales['en-US']?.description,
    'Log every hike.\n\nShare it with friends.',
  );
  assert.equal(snap.listing.appStore?.locales['de-DE']?.name, 'Wegnotizen');
  assert.equal(snap.listing.googlePlay?.locales['en-US']?.title, 'Trail Notes');
  assert.deepEqual(snap.listing.googlePlay?.changelogs['en-US'], {
    '42': 'Fixes.',
    default: 'Improvements.',
  });
  // review_information and android/ are not locales; screenshots and Fastfile are not listing files.
  assert.equal(Object.keys(snap.listing.appStore?.locales ?? {}).length, 2);
  assert.deepEqual(snap.warnings, []);
  assert.ok(!(`${IOS}/review_information/notes.txt` in snap.files));
});

test('a repository with no metadata yields an empty listing and the default roots', () => {
  const snap = readListing({ 'fastlane/Fastfile': '' });
  assert.deepEqual(snap.listing, {});
  assert.deepEqual(snap.found, { appStore: false, googlePlay: false });
  assert.equal(snap.roots.appStore, 'fastlane/metadata');
});

test('discovers the bare metadata/ defaults that deliver and supply also look for', () => {
  const snap = readListing({
    'metadata/en-US/name.txt': 'Trail Notes',
    'metadata/android/en-US/title.txt': 'Trail Notes',
  });
  assert.deepEqual(snap.roots, { appStore: 'metadata', googlePlay: 'metadata/android' });
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Trail Notes');
  assert.equal(snap.listing.googlePlay?.locales['en-US']?.title, 'Trail Notes');
});

test('supply can use metadata/ directly, with no android folder', () => {
  const snap = readListing({ 'metadata/en-US/title.txt': 'Trail Notes' });
  assert.equal(snap.roots.googlePlay, 'metadata');
  assert.equal(snap.listing.googlePlay?.locales['en-US']?.title, 'Trail Notes');
  assert.equal(snap.listing.appStore, undefined);
});

test('several roots: the shallowest wins and the rest are reported', () => {
  const snap = readListing({
    'fastlane/metadata/en-US/name.txt': 'A',
    'ios/fastlane/metadata/en-US/name.txt': 'B',
  });
  assert.equal(snap.roots.appStore, 'fastlane/metadata');
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'A');
  assert.match(snap.warnings.join('\n'), /Several App Store metadata folders/);
});

test('an explicit root is used as given', () => {
  const snap = readListing(
    { 'store/ios/en-US/name.txt': 'Trail Notes' },
    { roots: { appStore: 'store/ios/' } },
  );
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Trail Notes');
});

test('the default folder is a pseudo locale for the App Store only', () => {
  const snap = readListing({
    [`${IOS}/default/support_url.txt`]: 'https://example.com',
    [`${ANDROID}/default/title.txt`]: 'nope',
  });
  assert.equal(snap.listing.appStore?.locales.default?.support_url, 'https://example.com');
  assert.equal(snap.listing.googlePlay, undefined);
});

test('odd changelog names and non locale folders are reported, not guessed at', () => {
  const snap = readListing({
    [`${ANDROID}/en-US/title.txt`]: 'T',
    [`${ANDROID}/en-US/changelogs/v1.txt`]: 'x',
    [`${IOS}/en-US/name.txt`]: 'N',
    [`${IOS}/Resources/name.txt`]: 'x',
  });
  const text = snap.warnings.join('\n');
  assert.match(text, /changelogs\/v1\.txt/);
  assert.match(text, /fastlane\/metadata\/Resources: its name is not a locale code/);
});

test('listingFilePaths selects only the files worth reading', () => {
  const { paths } = listingFilePaths(Object.keys(repoFiles()));
  assert.ok(paths.includes(`${IOS}/en-US/name.txt`));
  assert.ok(paths.includes(`${ANDROID}/en-US/changelogs/42.txt`));
  assert.ok(!paths.includes('fastlane/Fastfile'));
  assert.ok(!paths.includes(`${IOS}/review_information/notes.txt`));
  assert.equal(paths.length, 13);
});

test('loadListing reads through the injected reader and reports vanished files', async () => {
  const files = repoFiles();
  const reads: string[] = [];
  const snap = await loadListing(Object.keys(files), async (p) => {
    reads.push(p);
    return p.endsWith('subtitle.txt') ? undefined : files[p];
  });
  assert.equal(reads.includes('fastlane/Fastfile'), false);
  assert.equal(snap.listing.appStore?.locales['en-US']?.subtitle, undefined);
  assert.match(snap.warnings.join('\n'), /subtitle\.txt was listed but could not be read/);
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Trail Notes');
});

test('round trip: reading and writing back the same model changes nothing', () => {
  const snap = readListing(repoFiles());
  assert.deepEqual(listingChangeSet(snap, snap.listing), []);
});

test('round trip: a value changed in one file changes only that file, keeping its conventions', () => {
  const files = repoFiles();
  files[`${IOS}/en-US/name.txt`] = 'Trail Notes'; // this one has no trailing newline
  const snap = readListing(files);
  const after = structuredClone(snap.listing);
  at(apple(after).locales, 'en-US').name = 'Trail Notes Pro';
  at(apple(after).locales, 'en-US').subtitle = 'Hike more';
  const changes = listingChangeSet(snap, after);
  assert.deepEqual(changes, [
    { path: `${IOS}/en-US/name.txt`, before: 'Trail Notes', after: 'Trail Notes Pro' },
    { path: `${IOS}/en-US/subtitle.txt`, before: 'Hike, log, share\n', after: 'Hike more\n' },
  ]);
});

test('applying the change set reproduces the edited model', () => {
  const files = repoFiles();
  const snap = readListing(files);
  const after = structuredClone(snap.listing);
  at(play(after).locales, 'en-US').short_description = 'Log hikes.';
  at(play(after).changelogs, 'en-US')['43'] = 'More fixes.';
  delete at(apple(after).locales, 'en-US').subtitle;
  const next: FileMap = { ...files };
  for (const change of listingChangeSet(snap, after)) {
    if (change.after === undefined) delete next[change.path];
    else next[change.path] = change.after;
  }
  assert.deepEqual(readListing(next).listing, after);
});

test('new files follow the store convention: trailing newline when the existing files have one', () => {
  const snap = readListing(repoFiles());
  const after = structuredClone(snap.listing);
  apple(after).locales['fr-FR'] = { name: 'Notes de sentier' };
  play(after).locales['fr-FR'] = { title: 'Notes de sentier' };
  const changes = listingChangeSet(snap, after);
  assert.deepEqual(changes, [
    { path: `${ANDROID}/fr-FR/title.txt`, after: 'Notes de sentier\n' },
    { path: `${IOS}/fr-FR/name.txt`, after: 'Notes de sentier\n' },
  ]);
});

test('new files have no trailing newline when existing files have none, or when told so', () => {
  const snap = readListing({
    [`${IOS}/en-US/name.txt`]: 'Trail Notes',
    [`${IOS}/en-US/subtitle.txt`]: 'Hike',
  });
  const after = structuredClone(snap.listing);
  at(apple(after).locales, 'en-US').keywords = 'a,b';
  assert.equal(listingChangeSet(snap, after)[0]?.after, 'a,b');
  assert.equal(listingChangeSet(snap, after, { newFileTrailingNewline: true })[0]?.after, 'a,b\n');
  // With no files at all, the fastlane default is no trailing newline, in the default roots.
  const empty = readListing({});
  const fresh: Listing = { appStore: { locales: { 'en-US': { name: 'X1' } } } };
  assert.deepEqual(listingChangeSet(empty, fresh), [
    { path: `${IOS}/en-US/name.txt`, after: 'X1' },
  ]);
});

test('CRLF files stay CRLF when changed, and an untouched CRLF file is not rewritten', () => {
  const snap = readListing({
    [`${IOS}/en-US/description.txt`]: 'line one\r\nline two\r\n',
    [`${IOS}/en-US/name.txt`]: 'Trail\r\n',
  });
  assert.equal(snap.listing.appStore?.locales['en-US']?.description, 'line one\nline two');
  const after = structuredClone(snap.listing);
  at(apple(after).locales, 'en-US').description = 'line one\nline two\nline three';
  assert.deepEqual(listingChangeSet(snap, after), [
    {
      path: `${IOS}/en-US/description.txt`,
      before: 'line one\r\nline two\r\n',
      after: 'line one\r\nline two\r\nline three\r\n',
    },
  ]);
});

test('removing a value or a locale deletes its files, and nothing else', () => {
  const snap = readListing(repoFiles());
  const after = structuredClone(snap.listing);
  delete apple(after).locales['de-DE'];
  delete at(play(after).changelogs, 'en-US').default;
  assert.deepEqual(listingChangeSet(snap, after), [
    { path: `${ANDROID}/en-US/changelogs/default.txt`, before: 'Improvements.\n' },
    { path: `${IOS}/de-DE/name.txt`, before: 'Wegnotizen\n' },
  ]);
});

test('a store that is absent from the new listing is left alone', () => {
  const snap = readListing(repoFiles());
  assert.deepEqual(
    listingChangeSet(snap, snap.listing.appStore ? { appStore: snap.listing.appStore } : {}),
    [],
  );
  assert.deepEqual(listingChangeSet(snap, {}), []);
});

test('an empty value is an empty file, not a deleted one', () => {
  const snap = readListing(repoFiles());
  const after = structuredClone(snap.listing);
  at(apple(after).locales, 'en-US').subtitle = '';
  assert.deepEqual(listingChangeSet(snap, after), [
    { path: `${IOS}/en-US/subtitle.txt`, before: 'Hike, log, share\n', after: '' },
  ]);
});

test('a value that ends with a line break survives the round trip', () => {
  const snap = readListing({ [`${IOS}/en-US/description.txt`]: 'a\n\n' });
  assert.equal(snap.listing.appStore?.locales['en-US']?.description, 'a\n');
  assert.deepEqual(listingChangeSet(snap, snap.listing), []);
});

test('the model validates: the sample listing is within every limit', () => {
  const problems = validateListing(readListing(repoFiles()).listing).filter(
    (p) => p.severity === 'error',
  );
  // de-DE only has a name, so it is missing required fields; en-US has none.
  assert.deepEqual(
    problems.filter((p) => p.locale === 'en-US'),
    [],
  );
  assert.ok(problems.some((p) => p.locale === 'de-DE' && p.field === 'description'));
});
