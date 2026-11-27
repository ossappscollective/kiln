import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StagedChangesView } from '@kiln/core';
import {
  prefillFromHash,
  assetsStatus,
  buildStatus,
  chosenOf,
  confirmAllowed,
  confirmHiddenReason,
  confirmStatus,
  neighbour,
  notesStatus,
  pickVersion,
  releaseStepHref,
  resolveStep,
  reviewStatus,
  type StepperFacts,
  stagedFacts,
  stagedNotes,
  stepFromHash,
  stepStatuses,
  storeNotes,
  visibleSteps,
  withStep,
} from './release-stepper.ts';

const facts = (extra: Partial<StepperFacts> = {}): StepperFacts => ({
  platform: 'ios',
  editable: { state: 'ready' },
  chosen: null,
  choices: 2,
  notes: { withText: 0, unsaved: 0, over: 0 },
  staged: { release: 0, texts: 0, assets: 0, total: 0, errors: 0, warnings: 0, unpushed: 0 },
  pipeline: { state: 'idle', waitingOn: null },
  ...extra,
});

const view = (extra: Partial<StagedChangesView> = {}): StagedChangesView =>
  ({
    app: { id: 'a', name: 'A', platform: 'ios', store: 'appstoreconnect' },
    text: [],
    assets: [],
    release: [],
    totals: { text: 0, assetSets: 0, assetFiles: 0, errors: 0, warnings: 0, changed: 0 },
    valid: true,
    pushable: { textFields: [] },
    limits: {} as never,
    ...extra,
  }) as StagedChangesView;

test('the step lives in the address and keeps the rest of it', () => {
  assert.equal(stepFromHash('#/portfolio/a1/releases?platform=ios&step=notes'), 'notes');
  assert.equal(stepFromHash('#/portfolio/a1/releases?step=nope'), null);
  assert.equal(stepFromHash('#/portfolio/a1/releases'), null);
  assert.equal(
    withStep('#/portfolio/a1/releases?platform=ios&version=2.4.0', 'review'),
    '#/portfolio/a1/releases?platform=ios&version=2.4.0&step=review',
  );
  assert.equal(
    withStep('#/portfolio/a1/releases?platform=ios&step=notes', null),
    '#/portfolio/a1/releases?platform=ios',
  );
  assert.equal(withStep('#/portfolio/a1/releases', 'build'), '#/portfolio/a1/releases?step=build');
});

test('a link to a step names the tab, the platform, the version and the step', () => {
  assert.equal(
    releaseStepHref('a1', 'ios', 'confirm', '2.4.0'),
    '#/portfolio/a1/releases?platform=ios&version=2.4.0&step=confirm',
  );
  assert.equal(releaseStepHref('a1', null, 'build'), '#/portfolio/a1/releases?step=build');
});

test('a viewer does not see Confirm; nobody does while every write switch is off', () => {
  const on = { draft: true, submit: true, release: true };
  assert.deepEqual(visibleSteps('admin', on), ['build', 'notes', 'assets', 'review', 'confirm']);
  assert.deepEqual(visibleSteps('member', on), ['build', 'notes', 'assets', 'review']);
  assert.deepEqual(visibleSteps('viewer', on), ['build', 'notes', 'assets', 'review']);
  const off = { draft: false, submit: false, release: false };
  assert.equal(confirmAllowed('owner', off), false);
  assert.equal(confirmAllowed('owner', { draft: false, submit: null, release: false }), true);
  assert.equal(confirmAllowed('owner', { draft: null, submit: null, release: null }), true);
  assert.match(confirmHiddenReason('member', on) as string, /admin or owner/);
  assert.match(confirmHiddenReason('admin', off) as string, /switched off/);
  assert.equal(confirmHiddenReason('admin', on), null);
});

test('moving between steps stays inside the visible ones', () => {
  const v = ['build', 'notes', 'assets', 'review'] as const;
  assert.equal(neighbour('notes', v, 1), 'assets');
  assert.equal(neighbour('build', v, -1), null);
  assert.equal(neighbour('review', v, 1), null);
  assert.equal(resolveStep('confirm', v), 'build');
  assert.equal(resolveStep('review', v), 'review');
  assert.equal(resolveStep(null, []), null);
});

test('staged facts count items, errors and what a push would write', () => {
  const problem = (severity: 'error' | 'warning') => ({ severity, code: 'x', message: 'm' });
  const v = view({
    text: [
      {
        id: 't1',
        pushed: false,
        status: 'changed',
        problems: [problem('warning')],
        field: 'release_notes',
        locale: 'en-US',
        value: 'Hi',
      },
      {
        id: 't2',
        pushed: false,
        status: 'unchanged',
        problems: [],
        field: 'description',
        locale: 'en-US',
        value: 'x',
      },
    ] as never,
    assets: [{ id: 'a1', pushed: true, files: [{}, {}], problems: [problem('error')] }] as never,
    release: [
      {
        id: 'r1',
        field: 'build',
        locale: '',
        value: 'b1',
        pushed: false,
        localOnly: false,
        problems: [],
      },
      {
        id: 'r2',
        field: 'user_fraction',
        locale: '',
        value: '0.1',
        pushed: false,
        localOnly: true,
        problems: [],
      },
    ] as never,
  });
  assert.deepEqual(stagedFacts(v), {
    release: 2,
    texts: 2,
    assets: 1,
    unpushedAssets: 0,
    total: 5,
    errors: 1,
    warnings: 1,
    unpushed: 2,
  });
  assert.deepEqual(stagedFacts(null).total, 0);
  assert.deepEqual(stagedNotes(v, 'ios'), { 'en-US': 'Hi' });
  assert.deepEqual(
    stagedNotes(
      view({ release: [{ field: 'release_notes', locale: 'de-DE', value: 'Hallo' }] as never }),
      'android',
    ),
    { 'de-DE': 'Hallo' },
  );
});

test('the chosen build is the staged one, else the one the store draft has', () => {
  const builds = [{ id: 'b1', buildNumber: '412' }] as never;
  const staged = view({
    release: [
      { field: 'build', locale: '', value: 'b1', localOnly: false, pushed: false, problems: [] },
    ] as never,
  });
  assert.deepEqual(chosenOf({ platform: 'ios', view: staged, editable: null, builds }), {
    label: 'Build 412',
    where: 'staged',
  });
  const editable = {
    store: 'appstoreconnect',
    platform: 'ios',
    version: { id: 'v', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', editable: true },
    releaseType: null,
    earliestReleaseDate: null,
    copyright: null,
    build: { id: 'b0', buildNumber: '410', processingState: 'VALID', expired: false },
    phasedRelease: null,
    releaseNotes: [{ locale: 'en-US', text: 'Old' }],
  } as never;
  assert.deepEqual(chosenOf({ platform: 'ios', view: view(), editable, builds }), {
    label: 'Build 410',
    where: 'store',
  });
  assert.equal(chosenOf({ platform: 'ios', view: view(), editable: null, builds }), null);
  assert.deepEqual(storeNotes(editable), { 'en-US': 'Old' });
  const play = view({
    release: [
      {
        field: 'track',
        locale: '',
        value: 'production',
        localOnly: false,
        pushed: false,
        problems: [],
      },
      {
        field: 'version_codes',
        locale: '',
        value: '240,241',
        localOnly: false,
        pushed: false,
        problems: [],
      },
    ] as never,
  });
  assert.deepEqual(chosenOf({ platform: 'android', view: play, editable: null, builds: [] }), {
    label: 'Version codes 240, 241 on production',
    where: 'staged',
  });
  const draft = {
    store: 'googleplay',
    platform: 'android',
    track: 'beta',
    draft: {
      name: null,
      status: 'draft',
      userFraction: null,
      versionCodes: ['9'],
      notes: [{ locale: 'en-US', text: 'N' }],
    },
    others: [],
  } as never;
  assert.deepEqual(chosenOf({ platform: 'android', view: view(), editable: draft, builds: [] }), {
    label: 'Version codes 9 on beta',
    where: 'store',
  });
  assert.deepEqual(storeNotes(draft), { 'en-US': 'N' });
});

test('the Build dot: chosen, blocked, none to choose, to do', () => {
  assert.equal(
    buildStatus(facts({ chosen: { label: 'Build 412', where: 'staged' } })).level,
    'ready',
  );
  assert.equal(
    buildStatus(facts({ chosen: { label: 'Build 412', where: 'staged' } })).text,
    'Build 412, staged',
  );
  assert.equal(buildStatus(facts({ editable: { state: 'none' } })).level, 'blocked');
  assert.match(buildStatus(facts({ editable: { state: 'none' } })).text, /Prepare for Submission/);
  assert.equal(buildStatus(facts({ choices: 0 })).level, 'attention');
  assert.equal(buildStatus(facts()).text, 'Choose a build');
  assert.equal(buildStatus(facts({ platform: 'android' })).text, 'Choose the version codes');
  assert.equal(buildStatus(facts({ editable: { state: 'loading' } })).level, 'unknown');
});

test('the Notes dot: unsaved first, then limit, then empty, then ready', () => {
  assert.equal(
    notesStatus(facts({ notes: { withText: 2, unsaved: 1, over: 0 } })).text,
    '1 language is not staged yet',
  );
  assert.equal(
    notesStatus(facts({ notes: { withText: 2, unsaved: 0, over: 2 } })).text,
    '2 texts are over the store limit',
  );
  assert.equal(notesStatus(facts()).level, 'todo');
  assert.equal(
    notesStatus(facts({ notes: { withText: 3, unsaved: 0, over: 0 } })).text,
    '3 languages have notes',
  );
});

test('the Assets and Review dots', () => {
  assert.equal(assetsStatus(facts()).level, 'optional');
  assert.equal(
    assetsStatus(
      facts({
        staged: { release: 0, texts: 0, assets: 2, total: 2, errors: 0, warnings: 0, unpushed: 2 },
      }),
    ).text,
    '2 graphic sets staged',
  );
  assert.equal(reviewStatus(facts()).level, 'optional');
  assert.equal(
    reviewStatus(
      facts({
        staged: { release: 1, texts: 1, assets: 0, total: 2, errors: 0, warnings: 1, unpushed: 2 },
      }),
    ).text,
    '2 staged changes, 1 warning',
  );
  assert.equal(
    reviewStatus(
      facts({
        staged: { release: 1, texts: 0, assets: 0, total: 1, errors: 2, warnings: 0, unpushed: 1 },
      }),
    ).level,
    'blocked',
  );
});

test('Google Play, only a build staged: the Confirm dot says the build is released, not pushed to a draft', () => {
  const build = { release: 2, texts: 0, assets: 0, total: 2, errors: 0, warnings: 0, unpushed: 2 };
  assert.equal(
    confirmStatus(facts({ platform: 'android', staged: build })).text,
    'Release the chosen build: 2 staged changes',
  );
  // Texts or graphics staged too: they need the draft, as before. App Store: unchanged.
  assert.equal(
    confirmStatus(facts({ platform: 'android', staged: { ...build, texts: 1 } })).text,
    'Push 2 staged changes to the store draft',
  );
  assert.equal(
    confirmStatus(facts({ staged: build })).text,
    'Push 2 staged changes to the store draft',
  );
});

test('the Confirm dot follows the staged changes, then the state of the release', () => {
  const staged = { release: 1, texts: 0, assets: 0, total: 1, errors: 0, warnings: 0, unpushed: 1 };
  assert.equal(confirmStatus(facts({ staged })).text, 'Push 1 staged change to the store draft');
  assert.equal(
    confirmStatus(facts({ pipeline: { state: 'draft', waitingOn: 'you' } })).text,
    'The draft is pushed: submit it for review',
  );
  assert.equal(
    confirmStatus(facts({ platform: 'android', pipeline: { state: 'draft', waitingOn: 'you' } }))
      .text,
    'The draft is pushed: release it at a share of users',
  );
  assert.equal(
    confirmStatus(facts({ pipeline: { state: 'in_review', waitingOn: 'store' } })).level,
    'optional',
  );
  assert.equal(
    confirmStatus(facts({ pipeline: { state: 'approved', waitingOn: 'you' } })).level,
    'todo',
  );
  assert.equal(confirmStatus(facts({ pipeline: null })).level, 'unknown');
  assert.equal(confirmStatus(facts({ staged: { ...staged, errors: 1 } })).level, 'blocked');
});

test('stepStatuses lists only the visible steps, in order', () => {
  const list = stepStatuses(facts(), ['build', 'review']);
  assert.deepEqual(
    list.map((s) => s.id),
    ['build', 'review'],
  );
});

test('the version is the one asked for, else the editable one, else the newest', () => {
  const options = [
    { version: '2.5.0', editable: false },
    { version: '2.4.0', editable: true },
  ];
  assert.equal(pickVersion('2.5.0', options), '2.5.0');
  assert.equal(pickVersion(null, options), '2.4.0');
  assert.equal(pickVersion('9', [{ version: '2.5.0', editable: false }]), '2.5.0');
  assert.equal(pickVersion(null, []), null);
});

test('chosenOf: the summary says which version the chosen codes are when every one is known to be the same, else stays as it was', () => {
  const play = view({
    release: [
      {
        field: 'track',
        locale: '',
        value: 'production',
        localOnly: false,
        pushed: false,
        problems: [],
      },
      {
        field: 'version_codes',
        locale: '',
        value: '90',
        localOnly: false,
        pushed: false,
        problems: [],
      },
    ] as never,
  });
  const known = (version: string | null, origin: 'ci' | 'release') => [
    { versionCode: '90', source: 'bundle' as const, sha256: null, inTrack: [], version, origin },
  ];
  assert.deepEqual(
    chosenOf({
      platform: 'android',
      view: play,
      editable: null,
      builds: [],
      codes: known('2.00.1', 'ci'),
    }),
    { label: 'Version code 90 · 2.00.1 on production', where: 'staged' },
  );
  // A release name is not a version read from the file; an unknown code is not claimed.
  assert.equal(
    chosenOf({
      platform: 'android',
      view: play,
      editable: null,
      builds: [],
      codes: known('2.00.1', 'release'),
    })?.label,
    'Version codes 90 on production',
  );
  assert.equal(
    chosenOf({ platform: 'android', view: play, editable: null, builds: [], codes: [] })?.label,
    'Version codes 90 on production',
  );
  const two = view({
    release: [
      {
        field: 'version_codes',
        locale: '',
        value: '90,91',
        localOnly: false,
        pushed: false,
        problems: [],
      },
    ] as never,
  });
  const both = [
    {
      versionCode: '90',
      source: 'bundle' as const,
      sha256: null,
      inTrack: [],
      version: '2.0',
      origin: 'ci' as const,
    },
    {
      versionCode: '91',
      source: 'apk' as const,
      sha256: null,
      inTrack: [],
      version: '2.0',
      origin: 'store' as const,
    },
  ];
  assert.equal(
    chosenOf({ platform: 'android', view: two, editable: null, builds: [], codes: both })?.label,
    'Version codes 90, 91 · 2.0',
  );
});

test('"Create release" fills the first step from the address: a plain version and a plain build, nothing else', () => {
  assert.deepEqual(prefillFromHash('#/portfolio/a/releases?platform=ios&version=2.00.1&step=build&build=95'), {
    version: '2.00.1',
    build: '95',
  });
  assert.deepEqual(prefillFromHash('#/portfolio/a/releases?version=2.0.1'), { version: '2.0.1', build: null });
  assert.equal(prefillFromHash('#/portfolio/a/releases?step=build'), null);
  assert.equal(prefillFromHash('#/portfolio/a/releases?version=%3Cb%3E&build=a%20b'), null);
});
