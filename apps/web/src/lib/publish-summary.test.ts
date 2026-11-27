import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import type { PlanStep, PublishPlan, PublishStepType } from './pending.ts';
import {
  buildDate,
  buildLink,
  cutText,
  DETAIL_ITEMS,
  GRAPHICS_FILES_SHOWN,
  graphicsDetail,
  notesDetail,
  notesPreview,
  publishSummary,
  shownErrors,
  textDetail,
} from './publish-summary.ts';
import type { DraftPreview } from './staged.ts';

type Fields = { field: string; locale?: string; after: string };

const field = (f: Fields, i: number) => ({
  id: `f${i}`,
  field: f.field,
  label: f.field,
  locale: f.locale ?? '',
  before: null,
  after: f.after,
  status: 'changed',
  localOnly: false,
});

const playPush = (fields: Fields[], assets: string[] = [], texts: string[] = []) => ({
  app: { id: 'a', name: 'Kiln', platform: 'android', store: 'googleplay' },
  version: null,
  text: texts.map((x, i) => ({
    id: `t${i}`,
    locale: 'en-US',
    field: x,
    after: 'x',
    status: 'changed',
  })),
  assets: assets.map((kind, i) => ({
    id: `s${i}`,
    locale: 'en-US',
    slot: { kind, device: null },
    status: 'changed',
  })),
  release: fields.map(field),
  summary: {
    fieldsChanged: fields.length,
    assetSetsChanged: assets.length,
    textChanged: texts.length,
  },
});

const step = (type: PublishStepType, over: Partial<PlanStep> = {}): PlanStep =>
  ({
    type,
    platform: 'android',
    order: 1,
    label: type,
    requested: false,
    included: true,
    availability: 'available',
    reason: null,
    irreversible: false,
    deferred: false,
    summary: null,
    request: { type },
    preview: null,
    problems: [],
    ...over,
  }) as PlanStep;

const plan = (steps: PlanStep[], over: Partial<PublishPlan> = {}): PublishPlan =>
  ({
    app: { id: 'a', name: 'Kiln', platform: 'android', store: 'googleplay' },
    steps,
    included: steps.filter((s) => s.included).length,
    direct: null,
    ...over,
  }) as PublishPlan;

const row = (s: ReturnType<typeof publishSummary>, id: string) =>
  s.rows.filter((r) => r.id === id)[0];

const PUSH = playPush(
  [
    { field: 'track', after: 'production' },
    { field: 'version_codes', after: '165' },
    { field: 'release_name', after: '1.26.2' },
    {
      field: 'release_notes',
      locale: 'en-US',
      after: 'Faster sync\nBug fixes\nNew icon\nMore\nEven more',
    },
    { field: 'release_notes', locale: 'de-DE', after: 'Schneller' },
  ],
  ['screenshot', 'screenshot', 'icon', 'feature_graphic'],
  [],
);

const playSteps = (release: Partial<PlanStep> = {}): PlanStep[] => [
  step('push_draft', { order: 1, preview: PUSH, summary: { textChanged: 0 } }),
  step('submit', { order: 2, deferred: true, summary: { versionString: null, texts: 0 } }),
  step('release', {
    order: 3,
    deferred: true,
    summary: { track: 'production', userFraction: 1, audience: 'percent' },
    ...release,
  }),
];

test('a Google Play plan says where it goes, which build, the notes and the assets', () => {
  const s = publishSummary({
    plan: plan(playSteps()),
    wanted: ['push_draft', 'submit', 'release'],
    identifier: 'com.example.kiln',
  });
  assert.equal(row(s, 'app')?.value, 'Kiln');
  assert.equal(row(s, 'destination')?.value, 'Google Play · Android');
  assert.equal(row(s, 'identifier')?.value, 'com.example.kiln');
  assert.equal(row(s, 'identifier')?.label, 'Package name');
  assert.equal(row(s, 'track')?.value, 'Production · 100% of users');
  assert.equal(row(s, 'track')?.chip, undefined);
  assert.equal(row(s, 'release')?.value, '1.26.2 (165)');
  assert.equal(row(s, 'notes')?.value, '2 languages');
  assert.equal(row(s, 'text')?.value, 'No text changes');
  assert.equal(row(s, 'graphics')?.value, '2 screenshot sets, 1 icon set, 1 feature graphic set');
  assert.equal(row(s, 'fields')?.value, '5 release fields');
  assert.equal(s.footnote, 'Nothing else is changed.');
  assert.equal(s.notes?.shown?.locale, 'en-US');
  assert.deepEqual(s.notes?.shown?.lines, ['Faster sync', 'Bug fixes', 'New icon']);
  assert.equal(s.notes?.shown?.truncated, true);
  assert.deepEqual(s.notes?.others, [{ locale: 'de-DE', empty: false, text: 'Schneller' }]);
  assert.equal(
    s.outcome,
    'Pressing Publish pushes these to Google Play as a draft, then submits the draft for review, then rolls out the draft release to Production for 100% of users. Review takes the store hours to days; you can follow it in Builds.',
  );
});

test('the outcome follows the ticked steps: no rollout wording without the release step', () => {
  const p = plan(playSteps());
  const two = publishSummary({ plan: p, wanted: ['push_draft', 'submit'], identifier: '' });
  assert.equal(
    two.outcome,
    'Pressing Publish pushes these to Google Play as a draft, then submits the draft for review. Review takes the store hours to days; you can follow it in Builds.',
  );
  assert.ok(!/roll/i.test(two.outcome));
  assert.equal(row(two, 'track')?.value, 'Production');
  assert.equal(row(two, 'identifier'), undefined);
  const one = publishSummary({ plan: p, wanted: ['push_draft'], identifier: '' });
  assert.equal(
    one.outcome,
    'Pressing Publish pushes these to Google Play as a draft. Nothing is submitted or released.',
  );
  const none = publishSummary({ plan: p, wanted: [], identifier: '' });
  assert.equal(none.nothing, true);
  assert.equal(none.outcome, 'Nothing will be published: tick at least one step.');
});

test('the Track and Share fields show live while the release step is not added', () => {
  const steps = [
    step('push_draft', { order: 1, preview: PUSH }),
    step('release', { order: 2, included: false, availability: 'needs_input', request: null }),
  ];
  const typed = publishSummary({
    plan: plan(steps),
    wanted: ['push_draft'],
    identifier: '',
    typed: { track: 'internal', fraction: 0.1 },
  });
  assert.equal(row(typed, 'track')?.value, 'Internal · 10% of users');
  assert.equal(row(typed, 'track')?.chip, 'Not added yet');
  assert.ok(!/roll/i.test(typed.outcome));
  const bad = publishSummary({
    plan: plan(steps),
    wanted: ['push_draft'],
    identifier: '',
    typed: { track: 'beta', fraction: null },
  });
  assert.equal(row(bad, 'track')?.value, 'Beta');
});

test('a direct Play release says it is sent in one step and reviewed by Google', () => {
  const s = publishSummary({
    plan: plan(
      [
        step('push_draft', { included: false, availability: 'not_requested', request: null }),
        step('release', {
          order: 3,
          request: { type: 'release', direct: true },
          summary: {
            track: 'production',
            userFraction: 0.5,
            audience: 'percent',
            direct: true,
            versionCodes: ['165', '166'],
            notesLanguages: ['en-US', 'fr-FR'],
          },
        }),
      ],
      { defaultedToDirect: true },
    ),
    wanted: ['release'],
    identifier: 'com.example.kiln',
  });
  assert.equal(row(s, 'release')?.value, 'Version codes 165, 166');
  assert.equal(row(s, 'notes')?.value, '2 languages');
  assert.equal(row(s, 'review')?.value, 'Google reviews it before users get it');
  assert.equal(
    s.outcome,
    'Pressing Publish sends the staged release to Production for 50% of users in one step, with no draft first. Review takes the store hours to days; you can follow it in Builds.',
  );
  assert.equal(s.footnote, null);
});

test('release notes: a locale without text is named, a long text is cut', () => {
  const push = playPush([
    { field: 'release_notes', locale: 'en-US', after: 'Hello' },
    { field: 'release_notes', locale: 'fr-FR', after: '  ' },
    { field: 'release_name', locale: 'es-ES', after: 'x' },
    { field: 'release_name', locale: 'it-IT', after: 'x' },
    { field: 'release_name', locale: 'pt-BR', after: 'x' },
  ]);
  const s = publishSummary({
    plan: plan([step('push_draft', { preview: push })]),
    wanted: ['push_draft'],
    identifier: '',
  });
  assert.equal(row(s, 'notes')?.value, '1 language');
  assert.equal(row(s, 'notes')?.hint, 'No release notes for fr-FR, es-ES, and it-IT and 1 more');
  assert.deepEqual(s.notes?.others, [{ locale: 'fr-FR', empty: true, text: '  ' }]);
  const long = notesPreview('en-US', `${'x'.repeat(200)}\n\na\nb\nc`);
  assert.equal(long.lines.length, 3);
  assert.equal(long.lines[0]?.length, 141);
  assert.ok(long.lines[0]?.endsWith('…'));
  assert.equal(long.truncated, true);
  assert.equal(notesPreview('en-US', '   ').empty, true);
});

const applePlan = (over: { submit?: object | null; release?: Partial<PlanStep> } = {}) => {
  const push = {
    app: { id: 'a', name: 'Kiln', platform: 'ios', store: 'appstoreconnect' },
    version: { id: 'v', versionString: '2.9.0', state: 'PREPARE_FOR_SUBMISSION' },
    text: [
      { id: 't1', locale: 'en-US', field: 'name', after: 'Kiln', status: 'changed' },
      { id: 't2', locale: 'en-US', field: 'release_notes', after: 'New things', status: 'changed' },
    ],
    assets: [],
    release: [
      field({ field: 'build', after: 'build-id' }, 0),
      field({ field: 'phased_release', after: 'on' }, 1),
    ],
    summary: { fieldsChanged: 2, assetSetsChanged: 0, textChanged: 2 },
  };
  const submit =
    over.submit === undefined
      ? {
          version: { id: 'v', versionString: '2.9.0', state: 'x', releaseType: null },
          build: { id: 'build-id', version: '165', processingState: 'VALID', expired: false },
          contents: {},
          checks: {},
          irreversible: [],
          app: {},
        }
      : over.submit;
  return {
    plan: plan(
      [
        step('push_draft', { platform: 'ios', preview: push }),
        step('submit', {
          platform: 'ios',
          order: 2,
          summary: { versionString: '2.9.0' },
          preview: submit,
        }),
        step('release', {
          platform: 'ios',
          order: 3,
          included: false,
          request: null,
          ...over.release,
        }),
      ],
      { app: { id: 'a', name: 'Kiln', platform: 'ios', store: 'appstoreconnect' } },
    ),
    wanted: ['push_draft', 'submit'] as PublishStepType[],
  };
};

test('an App Store plan names the version, the build number and the phased release', () => {
  const { plan: p, wanted } = applePlan();
  const s = publishSummary({ plan: p, wanted, identifier: 'com.example.kiln' });
  assert.equal(row(s, 'destination')?.value, 'App Store · iOS');
  assert.equal(row(s, 'identifier')?.label, 'Bundle ID');
  assert.equal(row(s, 'version')?.value, '2.9.0');
  assert.equal(row(s, 'build')?.value, '165');
  assert.equal(row(s, 'review')?.value, 'Submit version 2.9.0 for App Store review');
  assert.equal(row(s, 'phased')?.value, 'On: released to automatic updates over seven days');
  assert.equal(row(s, 'text')?.value, '1 text change: Title (App Store name)');
  assert.equal(row(s, 'notes')?.value, '1 language');
  assert.equal(
    s.outcome,
    'Pressing Publish writes these to the version in App Store Connect as a draft, then submits version 2.9.0 for App Store review. Review takes the store hours to days; you can follow it in Builds.',
  );
});

test('a build whose number the plan does not carry is not invented', () => {
  const staged = applePlan({ submit: null });
  const s = publishSummary({ plan: staged.plan, wanted: staged.wanted, identifier: '' });
  assert.equal(row(s, 'build')?.value, 'The build you chose (its number is not in the plan)');
  const none = publishSummary({ plan: staged.plan, wanted: ['submit'], identifier: '' });
  assert.equal(row(none, 'build')?.value, 'The build already in the draft');
  assert.equal(row(none, 'text'), undefined);
  assert.equal(none.footnote, 'Your staged changes are not pushed in this publish.');
});

test('French wording follows the same rules', () => {
  useLocale('fr');
  try {
    const s = publishSummary({
      plan: plan(playSteps()),
      wanted: ['push_draft'],
      identifier: '',
    });
    assert.equal(
      s.outcome,
      'En appuyant sur Publier, cela envoie ces éléments à Google Play comme brouillon. Rien n’est soumis ni publié.',
    );
    assert.equal(row(s, 'notes')?.value, '2 langues');
  } finally {
    useLocale('en');
  }
});

test('the prompt for a track or a share waits until the fields were touched', () => {
  const prompt = { code: 'track_required', severity: 'error', message: 'Name the track.' };
  const other = { code: 'blocked', severity: 'error', message: 'Blocked.' };
  const waiting = { availability: 'needs_input', problems: [prompt, other] } as PlanStep;
  assert.deepEqual(
    shownErrors(waiting, false).map((p) => p.code),
    ['blocked'],
  );
  assert.deepEqual(
    shownErrors(waiting, true).map((p) => p.code),
    ['track_required', 'blocked'],
  );
  const blocked = { availability: 'blocked', problems: [prompt] } as PlanStep;
  assert.equal(shownErrors(blocked, false).length, 1);
});

// ---------------------------------------------------------------------------------------------
// The default language of the release notes

const NOTES = [
  { locale: 'de-DE', text: 'Schneller' },
  { locale: 'en-US', text: 'Faster sync' },
  { locale: 'fr-FR', text: 'Plus rapide' },
];

test('the release notes preview is the default language when the push has a text for it', () => {
  const d = notesDetail(NOTES, 'en-US');
  assert.equal(d?.shown?.locale, 'en-US');
  assert.equal(d?.shownIsDefault, true);
  assert.equal(d?.title, 'Release notes (en-US, default)');
  assert.equal(d?.hint, null);
  assert.deepEqual(
    d?.others.map((o) => o.locale),
    ['de-DE', 'fr-FR'],
  );
  // en_us and a different case are the same language.
  assert.equal(notesDetail(NOTES, 'EN_us')?.shown?.locale, 'en-US');
});

test('without a known default language the first language is shown, and it says so', () => {
  const d = notesDetail(NOTES, null);
  assert.equal(d?.shown?.locale, 'de-DE');
  assert.equal(d?.shownIsDefault, false);
  assert.equal(d?.title, 'Release notes (de-DE)');
  assert.match(d?.hint ?? '', /not known here/);
});

test('a default language without a text in the push falls back to the first language with a text', () => {
  const d = notesDetail([{ locale: 'en-US', text: '  ' }, ...NOTES.slice(0, 1)], 'en-US');
  assert.equal(d?.shown?.locale, 'de-DE');
  assert.equal(d?.shownIsDefault, false);
  assert.match(d?.hint ?? '', /en-US\) has no release notes in this publish, so de-DE is shown/);
  assert.deepEqual(d?.others, [{ locale: 'en-US', empty: true, text: '  ' }]);
});

test('a single language needs no hint, with or without a default language', () => {
  const one = [{ locale: 'en-US', text: 'Fixes' }];
  assert.equal(notesDetail(one, null)?.hint, null);
  assert.equal(notesDetail(one, null)?.title, 'Release notes (en-US)');
  assert.equal(notesDetail(one, 'en-US')?.title, 'Release notes (en-US, default)');
  assert.equal(notesDetail(one, 'fr-FR')?.shown?.locale, 'en-US');
  assert.deepEqual(notesDetail(one, 'en-US')?.others, []);
  assert.equal(notesDetail([], 'en-US'), null);
});

test('the summary takes the default language from its input, and keeps every note for a later choice', () => {
  const input = {
    plan: plan(playSteps()),
    wanted: ['push_draft'] as PublishStepType[],
    identifier: '',
  };
  const without = publishSummary(input);
  assert.equal(without.notes?.shown?.locale, 'en-US');
  assert.match(without.notes?.hint ?? '', /not known here/);
  const withDefault = publishSummary({ ...input, defaultLocale: 'de-DE' });
  assert.equal(withDefault.notes?.shown?.locale, 'de-DE');
  assert.equal(withDefault.notes?.title, 'Release notes (de-DE, default)');
  assert.deepEqual(
    without.noteEntries.map((n) => n.locale),
    ['en-US', 'de-DE'],
  );
  assert.equal(notesDetail(without.noteEntries, 'de-DE')?.shown?.locale, 'de-DE');
});

// ---------------------------------------------------------------------------------------------
// The build: its link and its date

test('the build facts: version codes on Google Play, the build number on the App Store', () => {
  const play = publishSummary({ plan: plan(playSteps()), wanted: ['push_draft'], identifier: '' });
  assert.deepEqual(play.build, {
    kind: 'play',
    platform: 'android',
    version: '1.26.2',
    numbers: ['165'],
  });
  assert.equal(play.appId, 'a');
  const { plan: p, wanted } = applePlan();
  const apple = publishSummary({ plan: p, wanted, identifier: '' });
  assert.equal(apple.build?.kind, 'apple');
  assert.equal(apple.build?.platform, 'ios');
  assert.equal(apple.build?.version, '2.9.0');
});

test('the build link: the Play Console itself, never a page that was not built from known ids', () => {
  const link = buildLink(
    { kind: 'play', platform: 'android', version: '1.26.2', numbers: ['165', '166'] },
    null,
  );
  assert.equal(link.href, 'https://play.google.com/console/');
  assert.equal(link.label, 'Open Google Play Console (build 165, 166)');
  assert.match(link.title, /does not give Kiln/);
  const none = buildLink({ kind: 'play', platform: 'android', version: null, numbers: [] }, null);
  assert.equal(none.label, 'Open Google Play Console');
});

test('the build link: the TestFlight page of the app when the Apple id is known, else the list of apps', () => {
  const facts = { kind: 'apple', platform: 'ios', version: '2.9.0', numbers: ['412'] } as const;
  const known = buildLink(facts, '1234567890');
  assert.equal(known.href, 'https://appstoreconnect.apple.com/apps/1234567890/testflight');
  assert.equal(known.label, 'Open TestFlight in App Store Connect (build 412)');
  for (const id of [null, undefined, '', 'not-a-number']) {
    const missing = buildLink(facts, id);
    assert.equal(missing.href, 'https://appstoreconnect.apple.com/apps');
    assert.match(missing.title, /id of the app is not known|app id is not known/);
  }
  assert.equal(
    buildLink({ ...facts, numbers: [] }, '1').label,
    'Open TestFlight in App Store Connect',
  );
});

test('the build date: the origin of the store rows decides, with the server reason when there is none', () => {
  const play = { kind: 'play', platform: 'android', version: null, numbers: ['165'] } as const;
  assert.equal(buildDate(play, null), null, 'not read: nothing is said');
  assert.deepEqual(buildDate(play, [{ platform: 'android', buildNumber: '165', uploadedAt: null }]), {
    state: 'notProvided',
  });
  assert.deepEqual(
    buildDate(play, [
      { platform: 'android', buildNumber: '165', uploadedAt: null, origin: { builtAt: 7, builtFrom: 'ci' } },
    ]),
    { state: 'known', at: 7 },
    'a code built by a CI run is dated like everywhere else',
  );
  const apple = { kind: 'apple', platform: 'ios', version: '2.9.0', numbers: ['412'] } as const;
  const stored = [
    { platform: 'ios', buildNumber: '411', version: '2.9.0', uploadedAt: 100 },
    { platform: 'ios', buildNumber: '412', version: '2.9.0', uploadedAt: 200 },
    { platform: 'android', buildNumber: '412', version: '2.9.0', uploadedAt: 300 },
  ] as const;
  assert.deepEqual(buildDate(apple, stored), { state: 'known', at: 200 });
  assert.deepEqual(
    buildDate(apple, [{ platform: 'ios', buildNumber: '412', version: '2.9.0', uploadedAt: null }]),
    { state: 'notRead', reason: null },
  );
  const disabled = buildDate(apple, [
    {
      platform: 'ios',
      buildNumber: '412',
      version: '2.9.0',
      uploadedAt: null,
      origin: { builtAt: null, builtGap: 'reads_disabled' },
    },
  ]);
  assert.equal(disabled?.state, 'notRead');
  assert.equal(disabled?.state === 'notRead' ? disabled.reason?.key : null, 'reads_disabled');
  assert.deepEqual(buildDate(apple, []), { state: 'notRead', reason: null });
  // Not read (or no build named): nothing is said at all.
  assert.equal(buildDate(apple, null), null);
  assert.equal(buildDate({ ...apple, numbers: [] }, stored), null);
  assert.equal(buildDate(null, stored), null);
});

// ---------------------------------------------------------------------------------------------
// The texts and graphics, to see them one last time

const file = (n: number) => ({
  path: `up/${n}.png`,
  name: `shot-${n}.png`,
  oid: `oid${n}`,
  bytes: 1000 * n,
  width: 1290,
  height: 2796,
  format: 'png',
});
const preview = (text: object[], assets: object[], platform = 'ios'): DraftPreview =>
  ({
    app: { id: 'a', name: 'Kiln', platform, store: 'x' },
    version: null,
    text,
    assets,
    summary: {},
  }) as unknown as DraftPreview;
const textRow = (i: number, over: object = {}) => ({
  id: `t${i}`,
  locale: 'en-US',
  field: 'description',
  before: 'Old text',
  after: 'New text',
  localeExists: true,
  status: 'changed',
  ...over,
});
const setRow = (i: number, files: number, over: object = {}) => ({
  id: `en-US/screenshot:iphone_6_9${i}`,
  locale: 'en-US',
  slot: { kind: 'screenshot', device: 'APP_IPHONE_67' },
  status: 'changed',
  willUpload: files,
  willRemove: 0,
  before: { setExists: true, files: [] },
  after: { files: Array.from({ length: files }, (_, n) => file(n + 1)) },
  ...over,
});

test('cutText cuts on a word and says it cut', () => {
  assert.deepEqual(cutText('short'), { excerpt: 'short', cut: false });
  const long = cutText(`${'word '.repeat(80)}`, 50);
  assert.equal(long.cut, true);
  assert.ok(long.excerpt.endsWith('…'));
  assert.ok(long.excerpt.length <= 51);
  assert.equal(cutText('x'.repeat(300), 100).excerpt.length, 101);
});

test('the changed texts: field, language, new text, the text now in the store, cut with a flag', () => {
  const longText = 'A long description. '.repeat(30);
  const d = textDetail(
    preview(
      [
        textRow(1),
        textRow(2, {
          field: 'subtitle',
          locale: 'fr-FR',
          before: null,
          after: longText,
          status: 'new_locale',
          localeExists: false,
        }),
        textRow(3, { status: 'unchanged' }),
        textRow(4, { field: 'release_notes' }),
      ],
      [],
    ),
  );
  assert.equal(d?.total, 2);
  assert.equal(d?.more, 0);
  assert.deepEqual(
    d?.items.map((i) => [i.field, i.label, i.locale]),
    [
      ['description', 'Description', 'en-US'],
      ['subtitle', 'Subtitle', 'fr-FR'],
    ],
  );
  assert.equal(d?.items[0]?.before, 'Old text');
  assert.equal(d?.items[0]?.truncated, false);
  assert.equal(d?.items[1]?.before, null);
  assert.equal(d?.items[1]?.isNew, true);
  assert.equal(d?.items[1]?.truncated, true);
  assert.equal(d?.items[1]?.after, longText);
  assert.ok((d?.items[1]?.excerpt.length ?? 999) < longText.length);
  assert.equal(textDetail(null), null);
});

test('the changed texts show at most the cap and count the rest', () => {
  const rows = Array.from({ length: DETAIL_ITEMS + 5 }, (_, i) => textRow(i, { locale: `l${i}` }));
  const d = textDetail(preview(rows, []));
  assert.equal(d?.items.length, DETAIL_ITEMS);
  assert.equal(d?.more, 5);
  assert.equal(d?.total, DETAIL_ITEMS + 5);
  assert.equal(textDetail(preview(rows, []), 3)?.more, DETAIL_ITEMS + 2);
});

test('the changed graphics: one item per set with its files, counts and a device name', () => {
  const d = graphicsDetail(
    preview(
      [],
      [
        setRow(1, 3),
        setRow(2, 2, { status: 'unchanged' }),
        setRow(3, 1, { locale: 'de-DE', slot: { kind: 'icon', device: null } }),
      ],
    ),
  );
  assert.equal(d?.total, 2);
  const first = d?.items[0];
  assert.equal(first?.locale, 'en-US');
  assert.equal(first?.kind, 'screenshot');
  assert.match(first?.title ?? '', /^Screenshots · /);
  assert.equal(first?.fileCount, 3);
  assert.equal(first?.files.length, 3);
  assert.deepEqual(first?.files[0], {
    key: `${first?.id}#0`,
    name: 'shot-1.png',
    oid: 'oid1',
    path: 'up/1.png',
    width: 1290,
    height: 2796,
    bytes: 1000,
  });
  assert.equal(first?.willUpload, 3);
  assert.equal(d?.items[1]?.title, 'Store icon');
  assert.equal(graphicsDetail(null), null);
});

test('a graphics set caps its thumbnails and the list caps its sets', () => {
  const many = graphicsDetail(preview([], [setRow(1, GRAPHICS_FILES_SHOWN + 4)]));
  assert.equal(many?.items[0]?.files.length, GRAPHICS_FILES_SHOWN);
  assert.equal(many?.items[0]?.fileCount, GRAPHICS_FILES_SHOWN + 4);
  assert.equal(many?.items[0]?.moreFiles, 4);
  const sets = Array.from({ length: DETAIL_ITEMS + 2 }, (_, i) => setRow(i, 1));
  const capped = graphicsDetail(preview([], sets));
  assert.equal(capped?.items.length, DETAIL_ITEMS);
  assert.equal(capped?.more, 2);
  // A plan that does not carry the files (older server) lists none and does not fail.
  const bare = graphicsDetail(
    preview(
      [],
      [{ id: 's', locale: 'en-US', slot: { kind: 'icon', device: null }, status: 'changed' }],
      'android',
    ),
  );
  assert.equal(bare?.items[0]?.fileCount, 0);
  assert.deepEqual(bare?.items[0]?.files, []);
});

test('the summary carries the texts and graphics of the ticked push only', () => {
  const push = preview([textRow(1)], [setRow(1, 2)], 'android');
  const steps = [step('push_draft', { order: 1, preview: push })];
  const on = publishSummary({ plan: plan(steps), wanted: ['push_draft'], identifier: '' });
  assert.equal(on.texts?.total, 1);
  assert.equal(on.graphics?.total, 1);
  const off = publishSummary({ plan: plan(steps), wanted: [], identifier: '' });
  assert.equal(off.texts, null);
  assert.equal(off.graphics, null);
});

test('the combined step is described as it is: pushed and sent for review in one step, never as a draft', () => {
  const steps = [
    step('push_and_submit', {
      order: 2,
      irreversible: true,
      preview: playPush(
        [{ field: 'track', after: 'production' }],
        ['screenshot', 'icon'],
        ['title'],
      ),
      summary: { textChanged: 1, assetSetsChanged: 2, sendsForReview: true },
    }),
  ];
  const s = publishSummary({
    plan: plan(steps),
    wanted: ['push_and_submit'],
    identifier: 'com.example.kiln',
  });
  assert.equal(
    s.outcome,
    'Pressing Publish pushes these to Google Play and sends them for review in one step. Review takes the store hours to days; you can follow it in Builds.',
  );
  assert.doesNotMatch(s.outcome, /draft/i);
  // What is written is shown as for a push: the texts, the graphics, the track.
  assert.equal(row(s, 'track')?.value, 'Production');
  assert.equal(row(s, 'text')?.value, '1 text change: Title');
  assert.equal(row(s, 'graphics')?.value, '1 screenshot set, 1 icon set');
  assert.equal(
    row(s, 'review')?.value,
    'These changes go to Google Play review as part of the push',
  );
  // Not ticked: the outcome never mentions it, and the pair says what it always said.
  const pair = publishSummary({
    plan: plan([...steps, ...playSteps()]),
    wanted: ['push_draft', 'submit'],
    identifier: '',
  });
  assert.doesNotMatch(pair.outcome, /in one step/);
  assert.match(pair.outcome, /as a draft, then submits the draft for review/);
});

test('the combined step with a release after it keeps the order of the sentence', () => {
  const steps = [
    step('push_and_submit', {
      order: 2,
      irreversible: true,
      preview: PUSH,
      summary: { textChanged: 0 },
    }),
    step('release', {
      order: 4,
      deferred: true,
      summary: { track: 'production', userFraction: 1, audience: 'percent' },
    }),
  ];
  const s = publishSummary({
    plan: plan(steps),
    wanted: ['push_and_submit', 'release'],
    identifier: '',
  });
  assert.match(
    s.outcome,
    /^Pressing Publish pushes these to Google Play and sends them for review in one step, then rolls out the draft release to Production/,
  );
});

test('the combined step, French', () => {
  useLocale('fr');
  try {
    const s = publishSummary({
      plan: plan([
        step('push_and_submit', { order: 2, irreversible: true, preview: PUSH, summary: {} }),
      ]),
      wanted: ['push_and_submit'],
      identifier: '',
    });
    assert.match(
      s.outcome,
      /^En appuyant sur Publier, cela envoie ces éléments à Google Play et les soumet à l’examen en une seule étape\./,
    );
  } finally {
    useLocale('en');
  }
});

test('the summary carries the readiness of the plan: ready, or what would block the submit', () => {
  const none = publishSummary({ plan: plan(playSteps()), wanted: ['push_draft'], identifier: '' });
  assert.equal(none.readiness, null);

  const blocked = publishSummary({
    plan: plan(playSteps(), {
      readiness: {
        submit: {
          ready: false,
          blockers: [
            {
              code: 'missing_text',
              message: 'Description is empty in fr-FR',
              locale: 'fr-FR',
              item: 'description',
              fix: { kind: 'listing', href: '#/portfolio/a/listing?view=text&locale=fr-FR' },
            },
          ],
          unknown: ['image_not_ready'],
          predicted: true,
          checkedAt: 1,
        },
      },
    }),
    wanted: ['push_draft'],
    identifier: '',
  });
  assert.equal(blocked.readiness?.title, 'Submit would not run yet: 1 thing to fix');
  assert.equal(blocked.readiness?.lines[0]?.message, 'Description is empty in fr-FR');
  assert.equal(blocked.readiness?.note, 'Checked after the push: image processing.');

  const ready = publishSummary({
    plan: plan(playSteps(), {
      readiness: {
        submit: { ready: true, blockers: [], unknown: [], predicted: false, checkedAt: 1 },
      },
    }),
    wanted: ['push_draft'],
    identifier: '',
  });
  assert.equal(ready.readiness?.title, 'Ready to submit for review');
});

test('the blockers of a submit that cannot run are listed once, not again under the step', () => {
  const blocked = {
    availability: 'blocked',
    problems: [
      { code: 'submit_blocked_missing_text', severity: 'error', message: 'Description is empty in fr-FR' },
      { code: 'other', severity: 'error', message: 'Other.' },
    ],
  } as PlanStep;
  assert.deepEqual(
    shownErrors(blocked, true).map((p) => p.code),
    ['other'],
  );
});
