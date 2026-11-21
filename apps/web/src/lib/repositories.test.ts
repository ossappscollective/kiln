import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Listing } from '@kiln/core';
import { ApiError, messageFor } from './api.ts';
import {
  actorLabel,
  changelogCodes,
  changeSetActions,
  changeSetStatuses,
  changeSetStatusInfo,
  checkListingRoot,
  checkLocalPathInput,
  choiceButtonLabel,
  choiceNote,
  collapseDiff,
  connectChoices,
  connectProblem,
  defaultChoice,
  detectionPaths,
  differsOnlyInLineEnds,
  diffLines,
  diffStats,
  emptyListingDescription,
  emptyTargetForm,
  fieldUsage,
  filesChangedLabel,
  githubUrl,
  listingEdits,
  listingForChangeSet,
  listingIsEmpty,
  listingReadNotice,
  listingSourceBadge,
  localDisabledNotice,
  localReadSummary,
  localRootsHint,
  localStatusInfo,
  parseRepositoryInput,
  platformsSummary,
  projectKindBadge,
  projectKindSummary,
  readField,
  repositoryName,
  selectionForRequest,
  shortSha,
  showTargetBar,
  sourceProblem,
  splitLines,
  storeLocales,
  suggestSummary,
  targetFormFrom,
  targetFormProblems,
  targetInput,
  targetOptionLabel,
  targetRootsSummary,
  targetServerProblems,
  writeField,
} from './repositories.ts';
import type { ProjectDetection, RepositorySummary, StoreSource } from './types.ts';

// ---- connecting -------------------------------------------------------------------------------

test('owner/name is read as it is', () => {
  assert.deepEqual(parseRepositoryInput('acme/mobile-app'), {
    ok: true,
    owner: 'acme',
    repo: 'mobile-app',
  });
  assert.deepEqual(parseRepositoryInput('  acme/app.v2  '), {
    ok: true,
    owner: 'acme',
    repo: 'app.v2',
  });
});

test('a GitHub address gives its owner and name', () => {
  const expected = { ok: true, owner: 'acme', repo: 'app' };
  assert.deepEqual(parseRepositoryInput('https://github.com/acme/app'), expected);
  assert.deepEqual(parseRepositoryInput('https://github.com/acme/app.git'), expected);
  assert.deepEqual(parseRepositoryInput('github.com/acme/app/tree/main?tab=readme'), expected);
  assert.deepEqual(parseRepositoryInput('git@github.com:acme/app.git'), expected);
});

test('input that is not a repository is explained', () => {
  for (const bad of ['', 'acme', 'acme/app/extra', '-acme/app', 'acme/ap p', 'acme/..']) {
    const parsed = parseRepositoryInput(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.ok(parsed.message.length > 0);
  }
});

test('connect refusals land at the right field with what to check', () => {
  const target = { owner: 'acme', repo: 'app' };
  const err = (code: string, message = 'GitHub said no.') => ({ status: 422, code, message });
  assert.equal(connectProblem(err('already_connected'), target).field, 'repository');
  assert.equal(connectProblem(err('credential_not_found'), target).field, 'credential');
  const forbidden = connectProblem(err('github_forbidden'), target);
  assert.equal(forbidden.field, 'repository');
  assert.equal(forbidden.message, 'GitHub said no.');
  assert.match(forbidden.hint ?? '', /installed on acme/);
  assert.match(connectProblem(err('github_auth'), target).hint ?? '', /Credentials screen/);
  assert.match(connectProblem(err('github_not_found'), target).hint ?? '', /private repository/);
  assert.deepEqual(connectProblem(err('github_unavailable', 'Try later.'), target), {
    field: 'form',
    message: 'Try later.',
  });
});

test('API messages for repository errors are written for people', () => {
  assert.equal(
    messageFor(422, { error: 'github_forbidden', message: 'No access to acme/app.' }),
    'No access to acme/app.',
  );
  assert.match(messageFor(422, { error: 'github_forbidden' }), /does not have access/);
  assert.match(messageFor(409, { error: 'already_connected' }), /already connected/);
  assert.match(messageFor(409, { error: 'open_change_sets' }), /open change sets/);
  assert.match(messageFor(409, { error: 'invalid_state' }), /no longer in a state/);
  assert.match(messageFor(429, { error: 'rate_limited' }, 90), /2 minutes/);
  const conflict = messageFor(409, {
    error: 'change_conflict',
    message: 'Files changed.',
    paths: ['a.txt', 'b.txt'],
  });
  assert.match(conflict, /Files changed\. Changed files: a\.txt, b\.txt\./);
  assert.match(conflict, /Discard this change set/);
  const error = new ApiError(422, 'github_not_found', 'GitHub cannot find it.');
  assert.equal(connectProblem(error, { owner: 'o', repo: 'r' }).field, 'repository');
});

// ---- labels and rights ------------------------------------------------------------------------

test('every status has a label, and the tones tell states apart', () => {
  const labels = changeSetStatuses.map((s) => changeSetStatusInfo(s).label);
  assert.deepEqual(labels, ['Draft', 'Approved', 'Applying', 'Applied', 'Failed', 'Discarded']);
  assert.equal(changeSetStatusInfo('applied').tone, 'ok');
  assert.equal(changeSetStatusInfo('failed').tone, 'bad');
  assert.equal(changeSetStatusInfo('applying').dot, true);
});

test('project kinds read as badges', () => {
  assert.deepEqual(projectKindBadge(null), { label: 'Not scanned', tone: 'neutral' });
  assert.deepEqual(projectKindBadge('both'), { label: 'Fastlane and Expo', tone: 'accent' });
  assert.deepEqual(projectKindBadge('unknown'), { label: 'Not recognized', tone: 'warn' });
});

test('only an admin or owner approves and applies; a member discards only their own draft', () => {
  const mine = { type: 'user', id: 'u1' };
  const theirs = { type: 'user', id: 'u2' };
  const at = (
    role: 'owner' | 'admin' | 'member' | 'viewer',
    status: Parameters<typeof changeSetActions>[0]['status'],
    by = mine,
  ) => changeSetActions({ role, status, createdBy: by, myId: 'u1' });

  assert.deepEqual(at('admin', 'draft', theirs), { approve: true, apply: false, discard: true });
  assert.deepEqual(at('owner', 'approved', theirs), { approve: false, apply: true, discard: true });
  assert.deepEqual(at('admin', 'failed'), { approve: false, apply: false, discard: true });
  assert.deepEqual(at('admin', 'applied'), { approve: false, apply: false, discard: false });
  assert.deepEqual(at('admin', 'applying'), { approve: false, apply: false, discard: false });
  assert.deepEqual(at('member', 'draft'), { approve: false, apply: false, discard: true });
  assert.deepEqual(at('member', 'draft', theirs), { approve: false, apply: false, discard: false });
  assert.deepEqual(at('member', 'approved'), { approve: false, apply: false, discard: false });
  assert.deepEqual(at('viewer', 'draft'), { approve: false, apply: false, discard: false });
});

test('who did it reads as You, a name, or a kind of actor', () => {
  assert.equal(actorLabel({ type: 'user', id: 'u1' }, 'u1'), 'You');
  assert.equal(actorLabel({ type: 'user', id: 'u2' }, 'u1', { u2: 'Ada' }), 'Ada');
  assert.equal(actorLabel({ type: 'user', id: 'u3' }, 'u1', {}), 'A team member');
  assert.equal(actorLabel({ type: 'assistant', id: 'a' }, 'u1'), 'The assistant');
  assert.equal(filesChangedLabel(1), '1 file');
  assert.equal(filesChangedLabel(3), '3 files');
});

// ---- character counting -----------------------------------------------------------------------

test('usage is counted in the unit the store uses', () => {
  const name = { maxLength: 30, unit: 'characters' as const };
  assert.deepEqual(fieldUsage(name, 'Hello'), {
    count: 5,
    max: 30,
    unit: 'characters',
    over: false,
    under: false,
    text: '5 / 30 characters',
  });
  assert.equal(fieldUsage(name, 'x'.repeat(31)).over, true);
  assert.equal(fieldUsage(name, 'x'.repeat(30)).over, false);
  // Counted as code points, not UTF-16 units: one emoji is one character.
  assert.equal(fieldUsage(name, '\u{1F600}\u{1F600}').count, 2);
  // Keywords are measured in bytes: "é" is two.
  const keywords = { maxLength: 100, unit: 'bytes' as const };
  assert.equal(fieldUsage(keywords, 'café').count, 5);
  assert.equal(fieldUsage(keywords, 'café').text, '5 / 100 bytes');
  assert.equal(fieldUsage({ unit: 'characters' }, 'abc').text, '3 characters');
  assert.equal(fieldUsage({ minLength: 10, unit: 'characters' }, 'short').under, true);
  assert.equal(fieldUsage({ minLength: 10, unit: 'characters' }, '').under, false);
});

// ---- editing a listing ------------------------------------------------------------------------

const base = (): Listing => ({
  appStore: {
    locales: { 'en-US': { name: 'App', subtitle: 'Fast' }, de: { name: 'App' } },
    copyright: '2026 Acme',
  },
  googlePlay: {
    locales: { 'en-US': { title: 'App' } },
    changelogs: { 'en-US': { '12': 'Fixes', default: 'Notes', '103': 'More fixes' } },
  },
});

test('locales list the default folder first, then alphabetically', () => {
  const listing: Listing = { appStore: { locales: { 'en-US': {}, default: {}, de: {} } } };
  assert.deepEqual(storeLocales(listing, 'app_store'), ['default', 'de', 'en-US']);
  assert.deepEqual(storeLocales(listing, 'google_play'), []);
  assert.deepEqual(changelogCodes(base(), 'en-US'), ['103', '12', 'default']);
});

test('reading and writing a field leaves the original alone', () => {
  const original = base();
  assert.equal(readField(original, 'app_store', 'en-US', 'subtitle'), 'Fast');
  assert.equal(readField(original, 'app_store', undefined, 'copyright'), '2026 Acme');
  assert.equal(readField(original, 'google_play', 'en-US', 'changelog/12'), 'Fixes');
  assert.equal(readField(original, 'app_store', 'de', 'subtitle'), undefined);

  const next = writeField(original, 'app_store', 'de', 'subtitle', 'Schnell');
  assert.equal(readField(next, 'app_store', 'de', 'subtitle'), 'Schnell');
  assert.equal(readField(original, 'app_store', 'de', 'subtitle'), undefined);
  const notes = writeField(next, 'google_play', 'en-US', 'changelog/12', 'Better');
  assert.equal(readField(notes, 'google_play', 'en-US', 'changelog/12'), 'Better');
});

test('edits list only the fields that changed', () => {
  const original = base();
  assert.deepEqual(listingEdits(original, original), []);
  let edited = writeField(original, 'app_store', 'en-US', 'subtitle', 'Faster');
  edited = writeField(edited, 'app_store', undefined, 'copyright', '2027 Acme');
  const edits = listingEdits(original, edited);
  assert.deepEqual(
    edits.map((e) => [e.store, e.locale, e.field, e.before, e.after]),
    [
      ['app_store', 'en-US', 'subtitle', 'Fast', 'Faster'],
      ['app_store', undefined, 'copyright', '2026 Acme', '2027 Acme'],
    ],
  );
});

test('an empty box for a field without a file is not an edit', () => {
  const original = base();
  const touched = writeField(original, 'app_store', 'de', 'subtitle', '');
  assert.deepEqual(listingEdits(original, touched), []);
  // Clearing a field that has a file is an edit: the file becomes empty.
  const cleared = writeField(original, 'app_store', 'en-US', 'subtitle', '');
  assert.deepEqual(
    listingEdits(original, cleared).map((e) => e.after),
    [''],
  );
});

test('the change set carries every locale of an edited store and leaves other stores out', () => {
  const original = base();
  let edited = writeField(original, 'app_store', 'en-US', 'subtitle', 'Faster');
  edited = writeField(edited, 'app_store', 'de', 'subtitle', '');
  const listing = listingForChangeSet(original, edited);
  assert.equal(listing.googlePlay, undefined);
  assert.deepEqual(listing.appStore, {
    locales: { 'en-US': { name: 'App', subtitle: 'Faster' }, de: { name: 'App' } },
    copyright: '2026 Acme',
  });
  assert.deepEqual(listingForChangeSet(original, original), {});
});

test('a Play edit sends the whole Play listing including release notes', () => {
  const original = base();
  const edited = writeField(original, 'google_play', 'en-US', 'changelog/12', 'Better');
  const listing = listingForChangeSet(original, edited);
  assert.equal(listing.appStore, undefined);
  assert.deepEqual(listing.googlePlay?.changelogs, {
    'en-US': { '12': 'Better', default: 'Notes', '103': 'More fixes' },
  });
});

test('the suggested summary names the count and the locales', () => {
  const original = base();
  assert.equal(suggestSummary([]), '');
  const one = listingEdits(original, writeField(original, 'app_store', 'de', 'name', 'Neu'));
  assert.equal(suggestSummary(one), 'Update 1 listing field in de');
  let edited = writeField(original, 'app_store', 'de', 'name', 'Neu');
  edited = writeField(edited, 'app_store', 'en-US', 'name', 'New');
  assert.equal(
    suggestSummary(listingEdits(original, edited)),
    'Update 2 listing fields in de, en-US',
  );
  const copyright = listingEdits(
    original,
    writeField(original, 'app_store', undefined, 'copyright', 'x'),
  );
  assert.equal(suggestSummary(copyright), 'Update 1 listing field');
});

// ---- diff -------------------------------------------------------------------------------------

test('lines split without an extra empty line at the end', () => {
  assert.deepEqual(splitLines(undefined), []);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
});

test('a new file is all added lines, a deleted file all removed', () => {
  const added = diffLines(undefined, 'one\ntwo\n');
  assert.deepEqual(
    added.map((r) => [r.kind, r.text, r.oldNo, r.newNo]),
    [
      ['add', 'one', undefined, 1],
      ['add', 'two', undefined, 2],
    ],
  );
  const deleted = diffLines('one\n', undefined);
  assert.deepEqual(
    deleted.map((r) => [r.kind, r.oldNo, r.newNo]),
    [['del', 1, undefined]],
  );
});

test('a changed line shows the old and the new one in place', () => {
  const rows = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ['same:a', 'del:b', 'add:B', 'same:c'],
  );
  assert.deepEqual(
    rows.map((r) => [r.oldNo, r.newNo]),
    [
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [3, 3],
    ],
  );
  assert.deepEqual(diffStats(rows), { added: 1, removed: 1 });
});

test('inserted and removed lines in the middle keep the rest aligned', () => {
  const rows = diffLines('a\nb\nc\nd\n', 'a\nx\nb\nd\ne\n');
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ['same:a', 'add:x', 'same:b', 'del:c', 'same:d', 'add:e'],
  );
});

test('identical texts have no changes, and a missing final newline is noticed', () => {
  assert.deepEqual(diffStats(diffLines('a\nb\n', 'a\nb\n')), { added: 0, removed: 0 });
  assert.equal(differsOnlyInLineEnds('a\nb\n', 'a\nb'), true);
  assert.equal(differsOnlyInLineEnds('a\n', 'a\n'), false);
  assert.equal(differsOnlyInLineEnds('a\n', 'b\n'), false);
});

test('a very large change falls back to remove-then-add instead of hanging', () => {
  const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join('\n');
  const rows = diffLines(before, after);
  assert.deepEqual(diffStats(rows), { added: 1000, removed: 1000 });
  assert.equal(rows[0]?.kind, 'del');
});

test('long unchanged runs fold, with context kept around a change', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const changed = [...lines];
  changed[14] = 'changed';
  const blocks = collapseDiff(diffLines(lines.join('\n'), changed.join('\n')), 3);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.rows.length]),
    [
      ['collapsed', 11],
      ['rows', 8],
      ['collapsed', 12],
    ],
  );
  // Nothing to fold in a short file.
  assert.deepEqual(
    collapseDiff(diffLines('a\nb\n', 'a\nc\n')).map((b) => b.type),
    ['rows'],
  );
  assert.deepEqual(collapseDiff([]), []);
});

// ---- scan results -----------------------------------------------------------------------------

const detection = (over: Partial<ProjectDetection> = {}): ProjectDetection => ({
  kind: 'fastlane',
  platforms: ['ios'],
  platformsInferred: ['android'],
  locales: { ios: ['en-US'], android: [] },
  paths: {
    fastlaneDirs: ['fastlane'],
    fastfiles: ['fastlane/Fastfile'],
    iosMetadata: 'fastlane/metadata',
  },
  evidence: [],
  warnings: [],
  ...over,
});

test('the scan shows only the paths it found', () => {
  assert.deepEqual(detectionPaths(detection()), [
    { label: 'Fastlane folders', values: ['fastlane'] },
    { label: 'Fastfiles', values: ['fastlane/Fastfile'] },
    { label: 'App Store listing', values: ['fastlane/metadata'] },
  ]);
  assert.deepEqual(detectionPaths(detection({ paths: { fastlaneDirs: [], fastfiles: [] } })), []);
});

test('platforms read as a sentence, with guesses marked', () => {
  assert.equal(platformsSummary(detection()), 'iOS and Android (likely)');
  assert.equal(
    platformsSummary(detection({ platforms: ['ios', 'android'], platformsInferred: [] })),
    'iOS and Android',
  );
  assert.equal(
    platformsSummary(detection({ platforms: ['android'], platformsInferred: [] })),
    'Android',
  );
  assert.equal(platformsSummary(detection({ platforms: [], platformsInferred: [] })), 'None found');
});

// ---- where the listing comes from -------------------------------------------------------------

const source = (over: Partial<StoreSource> = {}): StoreSource => ({
  source: 'fastlane',
  path: 'fastlane/metadata',
  found: true,
  warnings: [],
  uncovered: [],
  unknown: [],
  ...over,
});

test('only a member and up reads the listing; a viewer gets a message, not a request', () => {
  assert.equal(listingReadNotice('viewer')?.includes('member'), true);
  for (const role of ['member', 'admin', 'owner'] as const)
    assert.equal(listingReadNotice(role), null, role);
});

test('the source badge names the Expo store config or fastlane', () => {
  assert.deepEqual(listingSourceBadge('expo-store-config'), {
    label: 'Expo store config',
    tone: 'accent',
  });
  assert.equal(listingSourceBadge('fastlane').label, 'Fastlane');
});

test('a source that cannot be read is explained', () => {
  const broken = source({
    source: 'expo-store-config',
    path: 'store.config.json',
    error: 'store.config.json is not valid JSON: x',
  });
  assert.match(sourceProblem(broken) ?? '', /not valid JSON.*fixed in the repository/);
  assert.equal(sourceProblem(source()), null);
});

test('the listing is empty only when nothing was found and nothing is broken', () => {
  const none = { found: { appStore: false, googlePlay: false } };
  const sources = {
    appStore: source(),
    googlePlay: source({ path: 'fastlane/metadata/android', found: false }),
  };
  assert.equal(listingIsEmpty({ ...none, sources }), true);
  assert.equal(listingIsEmpty({ found: { appStore: true, googlePlay: false }, sources }), false);
  const broken = {
    ...sources,
    appStore: source({
      source: 'expo-store-config',
      path: 'store.config.json',
      found: false,
      error: 'bad',
    }),
  };
  assert.equal(listingIsEmpty({ ...none, sources: broken }), false);
});

test('the empty message says where each store was looked for', () => {
  const text = emptyListingDescription({
    sources: {
      appStore: source({ source: 'expo-store-config', path: 'store.config.json', found: false }),
      googlePlay: source({ path: 'fastlane/metadata/android', found: false }),
    },
  });
  assert.match(text, /store\.config\.json/);
  assert.match(text, /fastlane\/metadata\/android/);
});

test('the project summaries no longer say Expo editing is missing', () => {
  assert.doesNotMatch(projectKindSummary('expo'), /not supported yet/);
  assert.match(projectKindSummary('both'), /store\.config\.json/);
  assert.match(projectKindSummary('both'), /Google Play listing comes from fastlane/);
});

// ---- listing targets --------------------------------------------------------------------------

test('a listing folder follows the repository path rules', () => {
  for (const ok of ['fastlane/metadata/ios', './fastlane/metadata/', 'metadata', 'a b/c.d']) {
    assert.equal(checkListingRoot(ok), undefined, ok);
  }
  for (const bad of [
    '',
    '  ',
    '/etc',
    '../x',
    'a/../b',
    'a//b',
    'a\\b',
    '.git/hooks',
    'x/.GIT/y',
    'a/./b',
    'x'.repeat(301),
  ]) {
    assert.notEqual(checkListingRoot(bad), undefined, JSON.stringify(bad));
  }
});

test('the target form needs a name and at least one valid folder', () => {
  const form = { ...emptyTargetForm(), name: 'Cards', appStoreRoot: 'fastlane/metadata/com.x/ios' };
  assert.deepEqual(targetFormProblems(form), {});
  assert.ok(targetFormProblems({ ...form, name: ' ' }).name);
  assert.ok(targetFormProblems({ ...form, appStoreRoot: '../x' }).appStoreRoot);
  assert.ok(targetFormProblems({ ...form, googlePlayRoot: '/abs' }).googlePlayRoot);
  assert.ok(targetFormProblems({ ...emptyTargetForm(), name: 'x' }).roots);
  assert.deepEqual(
    targetInput({ name: ' Cards ', appId: ' ', appStoreRoot: ' a/ios ', googlePlayRoot: '' }),
    {
      name: 'Cards',
      appId: null,
      appStoreRoot: 'a/ios',
      googlePlayRoot: null,
    },
  );
  assert.deepEqual(
    targetFormFrom({
      label: 'Cards',
      app: null,
      roots: { appStore: null, googlePlay: 'a/android' },
    }),
    { name: 'Cards', appId: '', appStoreRoot: '', googlePlayRoot: 'a/android' },
  );
});

test('a refused save is shown at the field it is about', () => {
  const refused = (code: string, body: Record<string, unknown> = {}, message = 'm') => ({
    code,
    message,
    body,
  });
  assert.deepEqual(targetServerProblems(refused('duplicate_name', {}, 'Taken.')), {
    name: 'Taken.',
  });
  assert.deepEqual(
    targetServerProblems(
      refused('invalid_target', {
        problems: [
          { field: 'appStoreRoot', message: 'No ..' },
          { field: 'name', message: 'Name?' },
        ],
      }),
    ),
    { appStoreRoot: 'No ..', name: 'Name?' },
  );
  assert.deepEqual(targetServerProblems(refused('boom')), {});
});

test('targets are labelled and summarized for the selector', () => {
  assert.equal(targetOptionLabel({ label: 'com.x', origin: 'detected' }), 'com.x');
  assert.equal(targetOptionLabel({ label: 'Mine', origin: 'custom' }), 'Mine (custom)');
  assert.equal(
    targetRootsSummary({ appStore: 'a/ios', googlePlay: 'a/android' }),
    'App Store: a/ios · Google Play: a/android',
  );
  assert.equal(
    targetRootsSummary({ appStore: null, googlePlay: 'a/android' }),
    'Google Play: a/android',
  );
  assert.equal(targetRootsSummary({ appStore: null, googlePlay: null }), 'no folders');
});

test('the target bar shows for several targets, a saved one, chosen folders, or a person who may add one', () => {
  const one = {
    targets: [
      {
        id: 'auto:default',
        origin: 'detected' as const,
        label: 'Default',
        app: null,
        roots: { appStore: 'a', googlePlay: null },
      },
    ],
  };
  assert.equal(
    showTargetBar(
      { ...one, selected: { id: 'auto:default', origin: 'default', label: 'Default' } },
      false,
    ),
    false,
  );
  assert.equal(
    showTargetBar(
      { ...one, selected: { id: 'auto:default', origin: 'default', label: 'Default' } },
      true,
    ),
    true,
  );
  assert.equal(showTargetBar({ targets: [...one.targets, ...one.targets] }, false), true);
  assert.equal(
    showTargetBar(
      { ...one, selected: { id: null, origin: 'folders', label: 'Chosen folders' } },
      false,
    ),
    true,
  );
  assert.equal(showTargetBar({}, false), false);
});

test('a change set is made in the target that was read, or in the folders that were chosen', () => {
  const roots = { appStore: 'a/ios', googlePlay: '' };
  assert.deepEqual(
    selectionForRequest({ roots, selected: { id: 'auto:app:x', origin: 'detected', label: 'x' } }),
    { target: 'auto:app:x' },
  );
  assert.deepEqual(
    selectionForRequest({ roots, selected: { id: 'abc', origin: 'custom', label: 'x' } }),
    { target: 'abc' },
  );
  assert.deepEqual(
    selectionForRequest({ roots, selected: { id: null, origin: 'folders', label: 'x' } }),
    { roots },
  );
  assert.deepEqual(selectionForRequest({ roots }), { roots });
});

test('a scan with several apps lists each one with its folders', () => {
  const detection = {
    paths: { fastlaneDirs: [], fastfiles: [] },
    listing: {
      candidates: [],
      targets: [
        {
          key: 'app:a',
          label: 'a',
          app: 'a',
          roots: { appStore: 'm/a/ios', googlePlay: 'm/a/android' },
        },
        {
          key: 'app:b',
          label: 'b',
          app: 'b',
          roots: { appStore: null, googlePlay: 'm/b/android' },
        },
      ],
    },
  } as unknown as ProjectDetection;
  const row = detectionPaths(detection).find((r) => r.label === 'Listing targets');
  assert.deepEqual(row?.values, [
    'a: App Store: m/a/ios · Google Play: m/a/android',
    'b: Google Play: m/b/android',
  ]);
  assert.equal(
    detectionPaths({ ...detection, listing: undefined } as ProjectDetection).some(
      (r) => r.label === 'Listing targets',
    ),
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// Local clones

const repo = (over: Partial<RepositorySummary> = {}): RepositorySummary => ({
  id: 'r1',
  credentialId: 'c1',
  owner: 'acme',
  repo: 'app',
  name: 'acme/app',
  defaultBranch: 'main',
  projectKind: null,
  detectedAt: null,
  createdAt: 1,
  localOnly: false,
  local: null,
  ...over,
});
const localOnly = (over: Partial<RepositorySummary> = {}) =>
  repo({
    id: 'l1',
    credentialId: null,
    owner: null,
    repo: null,
    name: 'oss-weather',
    localOnly: true,
    ...over,
  });
const checked = (over: Partial<Parameters<typeof connectChoices>[0]> = {}) => ({
  realPath: '/Volumes/dev/nativescript/oss-weather',
  remote: { host: 'github.com', owner: 'acme', repo: 'app', github: true },
  existing: null,
  ...over,
});

test('a local-only repository is named by its folder and has no GitHub address to open', () => {
  assert.equal(repositoryName(repo()), 'acme/app');
  assert.equal(repositoryName(localOnly()), 'oss-weather');
  assert.equal(repositoryName({ owner: null, repo: null }), 'Local repository');
  assert.equal(githubUrl('acme', 'app'), 'https://github.com/acme/app');
});

test('apply is offered to an admin for an approved change set, for any repository: the dialog says what is possible', () => {
  const base = {
    role: 'admin',
    status: 'approved',
    createdBy: { type: 'user', id: 'u2' },
    myId: 'u1',
  } as const;
  assert.deepEqual(changeSetActions(base), { approve: false, apply: true, discard: true });
  assert.equal(changeSetActions({ ...base, role: 'member' }).apply, false);
  assert.equal(changeSetActions({ ...base, status: 'draft' }).apply, false);
  assert.equal(changeSetActions({ ...base, status: 'draft' }).approve, true);
});

test('a folder path is checked as text before it is sent: absolute, no .., no control characters', () => {
  assert.deepEqual(checkLocalPathInput('  /Volumes/dev/nativescript/oss-weather \n'), {
    ok: true,
    path: '/Volumes/dev/nativescript/oss-weather',
  });
  assert.deepEqual(checkLocalPathInput('C:\\code\\app'), { ok: true, path: 'C:\\code\\app' });
  for (const bad of [
    '',
    '   ',
    'dev/app',
    '~/dev/app',
    './app',
    '/a/../b',
    '/a/..',
    '/a\u0000b',
    `/${'x'.repeat(4100)}`,
  ]) {
    assert.equal(checkLocalPathInput(bad).ok, false, JSON.stringify(bad).slice(0, 30));
  }
  assert.match((checkLocalPathInput('~/x') as { message: string }).message, /absolute/);
});

test('the read summary says which commit and branch are read and what is left out', () => {
  const sha = 'abc1234def5678abc1234def5678abc1234def56';
  assert.equal(shortSha(sha), 'abc1234');
  assert.equal(shortSha(null), '');
  assert.equal(
    localReadSummary({ branch: 'main', sha, checkedOutBranch: 'main', dirtyCount: 3 }),
    'Reads commit abc1234 on branch main; 3 uncommitted changes are not included.',
  );
  assert.equal(
    localReadSummary({ branch: 'main', sha, checkedOutBranch: 'main', dirtyCount: 1 }),
    'Reads commit abc1234 on branch main; 1 uncommitted change is not included.',
  );
  assert.equal(
    localReadSummary({ branch: 'main', sha, checkedOutBranch: 'main', dirtyCount: 0 }),
    'Reads commit abc1234 on branch main. The folder has no uncommitted changes.',
  );
  assert.match(
    localReadSummary({ branch: 'main', sha, checkedOutBranch: 'dev', dirtyCount: 3 }),
    /has dev checked out; only committed work on main is read/,
  );
  assert.match(
    localReadSummary({ branch: 'main', sha, checkedOutBranch: null, dirtyCount: 3 }),
    /detached HEAD/,
  );
  assert.match(localReadSummary({ branch: 'main', sha, dirtyCount: null }), /could not be counted/);
  assert.equal(
    localReadSummary({ branch: 'main', sha: null }),
    'Reads the latest commit on branch main. Uncommitted changes in the folder are never read.',
  );
});

test('the disabled notice names the setting and its value, or says why else', () => {
  const off = localDisabledNotice({
    enabled: false,
    envName: 'MRM_LOCAL_REPO_ROOTS',
    reason: 'no_roots',
  });
  assert.equal(off.title, 'Local clones are not enabled');
  assert.match(off.body, /MRM_LOCAL_REPO_ROOTS=\/Volumes\/dev/);
  assert.equal(off.envName, 'MRM_LOCAL_REPO_ROOTS');
  assert.match(
    localDisabledNotice({ enabled: false, envName: 'X', reason: 'reads_api' }).title,
    /MRM_READS=api/,
  );
  assert.match(
    localDisabledNotice({
      enabled: false,
      envName: 'X',
      reason: 'git_missing',
      message: 'Install git.',
    }).body,
    /Install git/,
  );
  assert.match(localRootsHint({ roots: ['/Volumes/dev'] }), /the allowed folder: \/Volumes\/dev/);
  assert.match(localRootsHint({ roots: ['/a', '/b'] }), /one of the allowed folders: \/a, \/b/);
  assert.match(localRootsHint(null), /allowed folder/);
});

test('the status of a stored folder is a label and a tone, never colour alone', () => {
  assert.deepEqual(localStatusInfo('ok'), { label: 'Readable', tone: 'ok', ok: true });
  for (const status of [
    'not_found',
    'outside_roots',
    'not_a_repository',
    'git_missing',
    'data_folder',
  ] as const) {
    const info = localStatusInfo(status);
    assert.equal(info.ok, false);
    assert.ok(info.label.length > 3);
  }
  assert.equal(localStatusInfo('reads_api').label, 'Reading from GitHub');
});

test('a checked folder is offered to the repository its origin names first, then others, then as local-only', () => {
  const app = repo();
  const other = repo({ id: 'r2', repo: 'other', name: 'acme/other' });
  const draft = localOnly();
  const choices = connectChoices(checked(), [other, draft, app]);
  assert.deepEqual(
    choices.map((c) => c.id),
    ['attach:r1', 'attach:r2', 'local-only'],
  );
  const first = choices[0];
  assert.ok(first?.kind === 'attach' && first.recommended && !first.needsConfirm);
  const second = choices[1];
  assert.ok(second?.kind === 'attach' && !second.recommended && second.needsConfirm);
  assert.equal(defaultChoice(choices)?.id, 'attach:r1');
  assert.equal(choiceButtonLabel(first), 'Attach to acme/app');
  assert.equal(choiceButtonLabel(choices[2]), 'Connect as local-only repository');
  assert.match(
    choiceNote(first as never, checked().remote) ?? '',
    /origin points at this repository/,
  );
  assert.match(
    choiceNote(second as never, checked().remote) ?? '',
    /acme\/app, a different repository/,
  );
  assert.match(choiceNote(choices[2] as never, null) ?? '', /Pull requests are not available/);
});

test('without a matching origin nothing is confirmed and local-only is the default; case does not matter', () => {
  const app = repo();
  const noOrigin = connectChoices(checked({ remote: null }), [app]);
  assert.equal(defaultChoice(noOrigin)?.id, 'local-only');
  const first = noOrigin[0];
  assert.ok(first?.kind === 'attach' && !first.needsConfirm && !first.recommended);
  const gitlab = connectChoices(
    checked({ remote: { host: 'gitlab.com', owner: 'acme', repo: 'app', github: false } }),
    [app],
  );
  assert.ok(gitlab[0]?.kind === 'attach' && !gitlab[0].needsConfirm);
  const upper = connectChoices(
    checked({ remote: { host: 'github.com', owner: 'ACME', repo: 'App', github: true } }),
    [app],
  );
  assert.ok(upper[0]?.kind === 'attach' && upper[0].recommended);
  assert.equal(defaultChoice([]), undefined);
  assert.equal(choiceButtonLabel(undefined), 'Choose what to do');
});

test('a folder that is already used offers nothing, except to the repository that has it', () => {
  const existing = { id: 'r1', name: 'acme/app', localOnly: false };
  assert.deepEqual(connectChoices(checked({ existing }), [repo()]), []);
  const own = repo({
    local: {
      path: '/Volumes/dev/nativescript/oss-weather',
      branch: 'main',
      name: 'x',
      headSha: null,
      lastReadAt: null,
      status: 'ok',
    },
  });
  assert.equal(connectChoices(checked({ existing }), [own], own).length, 1);
  assert.deepEqual(connectChoices(checked({ existing }), [own], repo({ id: 'r9' })), []);
});

test('attaching from a repository’s own page offers only that repository, and says what it replaces', () => {
  const withLocal = repo({
    local: {
      path: '/Volumes/dev/old',
      branch: 'main',
      name: 'old',
      headSha: null,
      lastReadAt: null,
      status: 'ok',
    },
  });
  const choices = connectChoices(checked(), [repo(), localOnly()], withLocal);
  assert.equal(choices.length, 1);
  const only = choices[0];
  assert.ok(only?.kind === 'attach');
  assert.equal(only.replaces, '/Volumes/dev/old');
  assert.match(choiceNote(only, null) ?? '', /Replaces its current local clone/);
  // A local-only repository is never a target.
  assert.deepEqual(
    connectChoices(checked(), [localOnly()]).map((c) => c.id),
    ['local-only'],
  );
});

test('the local clone error codes read as the server’s own message', () => {
  const m = (code: string, message: string) => messageFor(422, { error: code, message });
  assert.equal(
    m('local_outside_roots', 'Not inside an allowed folder.'),
    'Not inside an allowed folder.',
  );
  assert.equal(
    m('local_not_enabled', 'Set MRM_LOCAL_REPO_ROOTS=/Volumes/dev'),
    'Set MRM_LOCAL_REPO_ROOTS=/Volumes/dev',
  );
  assert.match(
    messageFor(409, { error: 'local_only', message: 'Applying is not available yet.' }),
    /not available yet/,
  );
  assert.match(
    messageFor(409, { error: 'remote_mismatch', message: 'origin is acme/other' }),
    /origin is acme\/other/,
  );
  assert.equal(
    messageFor(409, {
      error: 'already_connected',
      message: 'That folder is already connected as x.',
    }),
    'That folder is already connected as x.',
  );
  assert.equal(
    messageFor(409, { error: 'already_connected', message: 'acme/app is already connected.' }),
    'That repository is already connected to this workspace.',
  );
  assert.match(messageFor(409, { error: 'local_only' }), /request failed|local/i);
});
