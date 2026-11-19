import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  buildPullRequest,
  candidatesOf,
  canPullField,
  defaultPullSummary,
  detectedPullSource,
  groupSkipped,
  pullableFields,
  pullDisabledReason,
  pullErrorMessage,
  pullKey,
  selectedFields,
  selectionText,
  skipSubject,
  summarizePull,
  targetText,
  toggleAllDifferences,
  toggleKey,
} from './listing-pull.ts';
import type {
  DriftField,
  DriftLocale,
  DriftSide,
  DriftStatus,
  ProjectDetection,
  PullResult,
} from './types.ts';

const side = (value: string | null): DriftSide => ({
  value,
  observedAt: value === null ? null : 1,
  sourceRef: null,
  source: null,
});

function field(status: DriftStatus, partial: Partial<DriftField> = {}): DriftField {
  return {
    locale: 'en-US',
    field: 'name',
    label: 'Name',
    limit: 30,
    unit: 'characters',
    status,
    repo: side('Acme'),
    db: side('Acme'),
    live: side('Acme Pro'),
    problems: { repo: [], live: [] },
    ...partial,
  };
}

const locales: DriftLocale[] = [
  {
    locale: 'en-US',
    fields: [
      field('store-ahead', { field: 'name', label: 'Name' }),
      field('repo-ahead', { field: 'subtitle', label: 'Subtitle' }),
      field('identical', { field: 'description', label: 'Description' }),
    ],
  },
  {
    locale: 'de-DE',
    fields: [
      field('diverged', { locale: 'de-DE', field: 'name', label: 'Name' }),
      field('missing-in-one', {
        locale: 'de-DE',
        field: 'subtitle',
        label: 'Subtitle',
        missingIn: 'repo',
        repo: side(null),
      }),
      field('store-ahead', {
        locale: 'de-DE',
        field: 'keywords',
        label: 'Keywords',
        live: side('  '),
      }),
    ],
  },
];

test('only rows where the store is ahead or the two diverged, with a store value, can be pulled', () => {
  assert.equal(canPullField(field('store-ahead')), true);
  assert.equal(canPullField(field('diverged')), true);
  assert.equal(canPullField(field('repo-ahead')), false);
  assert.equal(canPullField(field('identical')), false);
  assert.equal(
    canPullField(field('missing-in-one', { missingIn: 'repo', repo: side(null) })),
    false,
  );
  assert.equal(canPullField(field('store-ahead', { live: side(null) })), false);
  assert.equal(canPullField(field('store-ahead', { live: side('   ') })), false);
});

test('pullable fields keep the display order and skip everything else', () => {
  assert.deepEqual(
    pullableFields(locales).map((f) => `${f.locale}/${f.field}`),
    ['en-US/name', 'de-DE/name'],
  );
});

test('a selection only holds rows that can still be pulled', () => {
  const selected = new Set([
    pullKey({ locale: 'en-US', field: 'name' }),
    pullKey({ locale: 'en-US', field: 'subtitle' }),
  ]);
  assert.deepEqual(
    selectedFields(locales, selected).map((f) => `${f.locale}/${f.field}`),
    ['en-US/name'],
  );
});

test('select all differences selects every pullable row, then clears', () => {
  const all = toggleAllDifferences(locales, new Set());
  assert.equal(all.size, 2);
  assert.ok(all.has(pullKey({ locale: 'de-DE', field: 'name' })));
  assert.equal(toggleAllDifferences(locales, all).size, 0);
  const some = toggleKey(new Set(), pullKey({ locale: 'en-US', field: 'name' }));
  assert.equal(toggleAllDifferences(locales, some).size, 2);
  assert.equal(
    toggleAllDifferences([{ locale: 'en-US', fields: [field('identical')] }], new Set()).size,
    0,
  );
});

test('toggling a key does not change the set it was given', () => {
  const before = new Set(['a']);
  const after = toggleKey(before, 'b');
  assert.deepEqual([...before], ['a']);
  assert.deepEqual([...after].sort(), ['a', 'b']);
  assert.deepEqual([...toggleKey(after, 'a')], ['b']);
});

test('the pull is disabled with a reason, in the order of what to fix first', () => {
  assert.match(
    pullDisabledReason({ role: 'viewer', repositoryId: 'r1', storeRead: true }) ?? '',
    /role cannot create change sets/,
  );
  assert.match(
    pullDisabledReason({ role: 'member', repositoryId: null, storeRead: true }) ?? '',
    /not linked to a repository/,
  );
  assert.match(
    pullDisabledReason({ role: 'member', repositoryId: 'r1', storeRead: false }) ?? '',
    /Refresh from the store/,
  );
  assert.equal(pullDisabledReason({ role: 'member', repositoryId: 'r1', storeRead: true }), null);
  assert.equal(pullDisabledReason({ role: 'owner', repositoryId: 'r1', storeRead: true }), null);
});

test('the request names the exact fields, and only sends options that are set', () => {
  const fields = pullableFields(locales);
  assert.deepEqual(buildPullRequest(fields, { channel: 'live', refresh: false }), {
    items: [
      { locale: 'en-US', field: 'name' },
      { locale: 'de-DE', field: 'name' },
    ],
    channel: 'live',
  });
  assert.deepEqual(
    buildPullRequest(fields.slice(0, 1), {
      channel: null,
      refresh: true,
      summary: '  Pull it  ',
      target: 'app/one',
    }),
    {
      items: [{ locale: 'en-US', field: 'name' }],
      refresh: true,
      summary: 'Pull it',
      target: 'app/one',
    },
  );
  assert.equal(
    'summary' in buildPullRequest(fields, { channel: 'live', refresh: false, summary: '   ' }),
    false,
  );
});

test('the selection and the summary are put into words', () => {
  assert.equal(selectionText(pullableFields(locales)), '2 fields in 2 locales');
  assert.equal(selectionText([{ locale: 'en-US' }]), '1 field in 1 locale');
  assert.equal(
    defaultPullSummary('Weather', 'ios'),
    'Pull the App Store listing of Weather into the repository',
  );
  assert.equal(
    defaultPullSummary('Weather', 'android'),
    'Pull the Google Play listing of Weather into the repository',
  );
  assert.ok(defaultPullSummary('x'.repeat(400), 'ios').length <= 200);
});

const detection = (partial: Partial<ProjectDetection>): ProjectDetection =>
  ({
    kind: 'expo',
    platforms: ['ios', 'android'],
    platformsInferred: [],
    locales: { ios: [], android: [] },
    paths: { fastlaneDirs: [], fastfiles: [] },
    evidence: [],
    warnings: [],
    ...partial,
  }) as ProjectDetection;

test('the detected target: the Expo store config for the App Store, else fastlane; Google Play is fastlane only', () => {
  const both = detection({
    paths: {
      fastlaneDirs: [],
      fastfiles: [],
      iosMetadata: 'fastlane/metadata',
      androidMetadata: 'fastlane/metadata/android',
    },
    expo: {
      dynamicConfig: false,
      buildProfiles: [],
      submitProfiles: [],
      storeConfigs: [{ path: 'store.config.json', dynamic: false }],
    },
  });
  assert.deepEqual(detectedPullSource(both, 'ios'), {
    source: 'expo-store-config',
    path: 'store.config.json',
  });
  assert.deepEqual(detectedPullSource(both, 'android'), {
    source: 'fastlane',
    path: 'fastlane/metadata/android',
  });
  const dynamicOnly = detection({
    paths: { fastlaneDirs: [], fastfiles: [], iosMetadata: 'fastlane/metadata' },
    expo: {
      dynamicConfig: false,
      buildProfiles: [],
      submitProfiles: [],
      storeConfigs: [{ path: 'store.config.js', dynamic: true }],
    },
  });
  assert.deepEqual(detectedPullSource(dynamicOnly, 'ios'), {
    source: 'fastlane',
    path: 'fastlane/metadata',
  });
  assert.equal(detectedPullSource(detection({}), 'ios'), null);
  assert.equal(detectedPullSource(detection({}), 'android'), null);
  assert.equal(detectedPullSource(null, 'ios'), null);
  assert.equal(
    targetText({ repository: 'acme/app', branch: 'main', path: 'store.config.json' }),
    'acme/app, branch main, store.config.json',
  );
});

test('skipped fields are grouped by reason and named by what was skipped', () => {
  const groups = groupSkipped([
    { locale: 'de-DE', field: 'name', reason: 'over_limit', message: 'Too long.' },
    { locale: 'fr-FR', reason: 'locale_not_in_repo', message: 'No folder.' },
    { locale: 'en-US', field: 'subtitle', reason: 'repo_ahead', message: 'Repo is ahead.' },
    { locale: 'es-ES', field: 'name', reason: 'over_limit', message: 'Too long.' },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.reason, g.items.length]),
    [
      ['repo_ahead', 1],
      ['over_limit', 2],
      ['locale_not_in_repo', 1],
    ],
  );
  const labelOf = (f: string) => (f === 'name' ? 'Name' : f);
  assert.equal(skipSubject({ locale: 'de-DE', field: 'name' }, labelOf), 'de-DE, Name');
  assert.equal(skipSubject({ locale: 'fr-FR' }, labelOf), 'fr-FR');
  assert.deepEqual(groupSkipped([]), []);
});

function result(partial: Partial<PullResult> = {}): PullResult {
  return {
    changeSet: {
      id: 'cs1',
      repositoryId: 'r1',
      filesChanged: 2,
    } as unknown as PullResult['changeSet'],
    channel: 'live',
    store: { readAt: 1, error: null, refreshed: false },
    target: {
      repositoryId: 'r1',
      repository: 'acme/app',
      branch: 'main',
      source: 'fastlane',
      path: 'fastlane/metadata',
      selected: { id: null, origin: 'detected', label: 'fastlane' },
    },
    changes: [
      {
        locale: 'en-US',
        repoLocale: 'en-US',
        field: 'name',
        label: 'Name',
        status: 'store-ahead',
        before: 'A',
        after: 'B',
        newLocale: false,
      },
      {
        locale: 'en-US',
        repoLocale: 'en-US',
        field: 'subtitle',
        label: 'Subtitle',
        status: 'diverged',
        before: 'A',
        after: 'B',
        newLocale: false,
      },
    ],
    skipped: [],
    problems: [],
    locales: [],
    warnings: [],
    ...partial,
  };
}

test('a created draft is summarized with its counts, and is calm when nothing was left out', () => {
  const summary = summarizePull(result());
  assert.equal(summary.tone, 'ok');
  assert.equal(summary.headline, 'Created a draft change set: 2 fields in 1 locale, 2 files.');
  assert.deepEqual(summary.details, []);
});

test('left-out fields and warnings turn the summary into a warning and are counted', () => {
  const summary = summarizePull(
    result({
      skipped: [{ locale: 'de-DE', field: 'name', reason: 'over_limit', message: 'Too long.' }],
      warnings: ['A locale folder was created.'],
    }),
  );
  assert.equal(summary.tone, 'warn');
  assert.ok(summary.details.some((d) => d.startsWith('1 field was left out')));
  assert.ok(summary.details.includes('A locale folder was created.'));
});

test('no differences is an answer with an explanation, not an error', () => {
  const summary = summarizePull(
    result({
      changeSet: null,
      changes: [],
      explanation: 'The repository already has the store text.',
    }),
  );
  assert.equal(summary.tone, 'info');
  assert.equal(summary.headline, 'The repository already has the store text.');
  assert.equal(
    summarizePull(result({ changeSet: null, changes: [] })).headline,
    'Nothing to pull.',
  );
});

test('a target_required answer carries the places to choose from', () => {
  const candidate = {
    id: 'app/one',
    origin: 'detected',
    label: 'App one',
    app: null,
    roots: { appStore: 'a', googlePlay: null },
  };
  const error = new ApiError(422, 'target_required', 'Choose', undefined, {
    candidates: [candidate, 'junk', null],
  });
  assert.deepEqual(candidatesOf(error), [candidate]);
  assert.deepEqual(
    candidatesOf(new ApiError(422, 'no_repository', 'x', undefined, { candidates: [candidate] })),
    [],
  );
  assert.deepEqual(candidatesOf(new ApiError(422, 'target_required', 'x')), []);
});

test('errors say what to do next', () => {
  assert.match(
    pullErrorMessage(new ApiError(422, 'no_repository', 'x')),
    /not linked to a repository/,
  );
  assert.match(
    pullErrorMessage(new ApiError(422, 'no_store_listing', 'x')),
    /Refresh from the store/,
  );
  assert.match(pullErrorMessage(new ApiError(422, 'target_required', 'x')), /Choose where/);
  assert.match(
    pullErrorMessage(new ApiError(429, 'rate_limited', 'x', 12)),
    /Try again in 12 seconds/,
  );
  assert.match(pullErrorMessage(new ApiError(429, 'rate_limited', 'x', 1)), /1 second\./);
  assert.match(pullErrorMessage(new ApiError(429, 'rate_limited', 'x')), /Try again in a minute/);
  assert.equal(pullErrorMessage(new ApiError(500, 'internal', 'Boom')), 'Boom');
});
