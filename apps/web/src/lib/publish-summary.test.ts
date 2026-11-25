import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import type { PlanStep, PublishPlan, PublishStepType } from './pending.ts';
import { notesPreview, publishSummary, shownErrors } from './publish-summary.ts';

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
  text: texts.map((x, i) => ({ id: `t${i}`, locale: 'en-US', field: x, after: 'x', status: 'changed' })),
  assets: assets.map((kind, i) => ({
    id: `s${i}`,
    locale: 'en-US',
    slot: { kind, device: null },
    status: 'changed',
  })),
  release: fields.map(field),
  summary: { fieldsChanged: fields.length, assetSetsChanged: assets.length, textChanged: texts.length },
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
    { field: 'release_notes', locale: 'en-US', after: 'Faster sync\nBug fixes\nNew icon\nMore\nEven more' },
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
  assert.equal(s.notes?.first?.locale, 'en-US');
  assert.deepEqual(s.notes?.first?.lines, ['Faster sync', 'Bug fixes', 'New icon']);
  assert.equal(s.notes?.first?.truncated, true);
  assert.deepEqual(s.notes?.others, [{ locale: 'de-DE', empty: false }]);
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
  assert.deepEqual(s.notes?.others, [{ locale: 'fr-FR', empty: true }]);
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
        step('release', { platform: 'ios', order: 3, included: false, request: null, ...over.release }),
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
    assert.equal(s.outcome, 'En appuyant sur Publier, cela envoie ces éléments à Google Play comme brouillon. Rien n’est soumis ni publié.');
    assert.equal(row(s, 'notes')?.value, '2 langues');
  } finally {
    useLocale('en');
  }
});

test('the prompt for a track or a share waits until the fields were touched', () => {
  const prompt = { code: 'track_required', severity: 'error', message: 'Name the track.' };
  const other = { code: 'blocked', severity: 'error', message: 'Blocked.' };
  const waiting = { availability: 'needs_input', problems: [prompt, other] } as PlanStep;
  assert.deepEqual(shownErrors(waiting, false).map((p) => p.code), ['blocked']);
  assert.deepEqual(shownErrors(waiting, true).map((p) => p.code), ['track_required', 'blocked']);
  const blocked = { availability: 'blocked', problems: [prompt] } as PlanStep;
  assert.equal(shownErrors(blocked, false).length, 1);
});
