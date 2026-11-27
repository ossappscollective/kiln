import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from './index.ts';

/**
 * The export surface of the SINGLE OWNERS (docs/state-model.md, "Single owners (core)"). The names Wave 2 imports to delete the duplicates
 * are pinned here, so a rename or a removal breaks loudly in core before it breaks a page. Each entry is a function unless it says
 * otherwise. Adding a name is free; changing one means updating this list AND the table in the docs.
 */

const FUNCTIONS = [
  // versions: one comparator, live, obsolete, create rules, candidates, build origin
  'compareVersions',
  'tryCompareVersions',
  'compareBuildNumbers',
  'tryCompareBuildNumbers',
  'compareReleases',
  'tryCompareReleases',
  'sameVersion',
  'parseVersion',
  'isReadableVersion',
  'isCreatableVersion',
  'naturalCompare',
  'newestVersionFirst',
  'newestBuildFirst',
  'newestReleaseFirst',
  'liveOf',
  'isObsolete',
  'obsoleteReasonOf',
  'isObsoleteVersion',
  'isNewerThanLive',
  'isServingStatus',
  'isPreparingStatus',
  'isPastPrepareStatus',
  'createReleaseRules',
  'newestNonEditableVersion',
  'storeVersionsOf',
  'analyzeCandidates',
  'promoteOptionsOf',
  'obsoleteVersionsOf',
  'pipelineIsObsolete',
  'stallLeftBehind',
  'joinBuildOrigin',
  'originOfBuild',
  'buildNumberOfBuild',
  'trackKind',
  'isProductionTrack',
  'isInternalTrack',
  'isOptInTrack',
  'playChannelOf',
  'sameTrack',
  // images
  'groupStoreImages',
  'displayKeyOf',
  'findDisplay',
  'findStoreImage',
  'refsOfDisplay',
  'limitOf',
  'predictedImagesOf',
  'compareRows',
  'compareDisplay',
  'compareSentence',
  'pullRefOf',
  'pullRefsOfDisplay',
  'assetFact',
  'imagePathOf',
  'storeImageFacts',
  'displayImageFacts',
  'measuredPathsOf',
  'validateImageFacts',
  'readinessImagesOf',
  'isUnpushed',
  'stagedCountsOf',
  // listing facts
  'parseLocale',
  'normalizeLocaleCode',
  'isLocaleCode',
  'isLocaleOrDefault',
  'localeKey',
  'languageOfLocale',
  'equivalentLocaleKeys',
  'localeGroupKey',
  'storeCodeOf',
  'localesMatch',
  'mergeLocales',
  'isRepoLocaleFolder',
  'matchLocale',
  'baseLocaleOf',
  'storeCopyView',
  'pickCopy',
  'copyText',
  'stagedBaselineOf',
  'isUnchangedStaged',
  'measureField',
  'textLimitOf',
  'releaseNotesLimitOf',
  'fieldSpecOf',
  'requiredFieldsOf',
  'emptyRequiredTexts',
  'checkTextField',
  'validateListingText',
  'validateLocaleText',
  'checkListingField',
  'normalizeStoreText',
  'sameListingText',
  'notesView',
] as const;

/** Values that are not functions: constants and tables. */
const VALUES = [
  'PLAY_TRACKS',
  'PLAY_TRACK_ORDER',
  'SERVING_STATUSES',
  'PREPARING_STATUSES',
  'PAST_PREPARE_STATUSES',
  'NO_ORIGIN_SOURCES',
  'LOCALE_EQUIVALENTS',
  'COPY_INTENT_CONSUMERS',
  'NOTE_SOURCE_ORDER',
  'RELEASE_NOTES_FIELD',
  'DEFAULT_LOCALE_FOLDER',
  'MAX_LOCALE_LENGTH',
] as const;

/** The OLD exports kept as thin delegates, so nothing that imports them breaks until Wave 2 moves it. */
const KEPT = [
  'compareDottedVersions',
  'isDottedVersion',
  'nextVersion',
  'newestDottedVersion',
  'sameLocale',
  'normalizeLocale',
  'isPlanLocale',
  'slotLimitProblem',
  'checkStoreImages',
  'assetFactsOf',
  'validateAssets',
  'summarizeAssets',
  'validateListing',
  'countCharacters',
  'countBytes',
  'compareText',
  'compareSet',
  'primaryStoreSet',
  'releaseNotesLimit',
  'releaseNotesLength',
] as const;

const exported = core as unknown as Record<string, unknown>;

test('every single-owner function is exported from the package', () => {
  const missing = FUNCTIONS.filter((n) => typeof exported[n] !== 'function');
  assert.deepEqual(missing, []);
});

test('every single-owner constant and table is exported', () => {
  const missing = VALUES.filter((n) => exported[n] === undefined || typeof exported[n] === 'function');
  assert.deepEqual(missing, []);
});

test('the old names still exist and still answer (delegating to the owners)', () => {
  const missing = KEPT.filter((n) => typeof exported[n] !== 'function');
  assert.deepEqual(missing, []);
  // delegation, not a second implementation: the old answers are the owner's
  assert.equal(core.compareDottedVersions('2.00.1', '2.0.1'), 0);
  assert.equal(core.compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(core.sameLocale('it', 'it-IT'), true);
  assert.equal(core.normalizeLocale('pt_br'), 'pt-BR');
  assert.equal(core.isPlanLocale('pt_BR'), true);
  assert.equal(exported.slotMaxFiles, undefined, 'the second limit table is gone: limitOf is the only one');
});

test('the two limit tables keep distinct names: limitOf is the image table, textLimitOf the listing text table', () => {
  assert.equal(core.limitOf('google_play', 'screenshot').max, 8);
  assert.equal(core.textLimitOf('google_play', 'release_notes')?.max, 500);
});

test('one owner per fact: no function name is exported by two owners (a duplicate would make the package ambiguous)', () => {
  const names = new Set<string>();
  for (const n of FUNCTIONS) {
    assert.equal(names.has(n), false, n);
    names.add(n);
  }
});
