import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CoachInput,
  type CoachKeyword,
  type CoreText,
  buildCoach,
  checkPlayProposal,
  checkTerm,
  compareRollout,
  rolloutOffer,
  rolloutTemplatesFor,
  storeRollout,
  validateRolloutSteps,
} from '@kiln/core';
import {
  coachWords,
  coreMessage,
  knowsCoreText,
  playCheckMessage,
  rolloutOfferMessage,
  rolloutComparisonMessage,
  rolloutIssueMessage,
  templateDescription,
  templateName,
  termReason,
} from './core-text.ts';
import { useLocale } from './i18n/test-setup.ts';

const NOW = Date.UTC(2027, 0, 20);
const kw = (id: string, term: string, extra: Partial<CoachKeyword> = {}): CoachKeyword => ({
  id,
  term,
  country: 'us',
  locale: 'en-US',
  state: 'ranked',
  rank: 10,
  lastCheckedAt: 1000,
  change: null,
  ...extra,
});
const coachInput = (extra: Partial<CoachInput>): CoachInput => ({
  platform: 'ios',
  now: NOW,
  keywords: [],
  competitors: [],
  competitorsAbove: [],
  listingLocales: [],
  lastCheckAt: NOW,
  rankMoveThreshold: 3,
  ...extra,
});

/** Every action of a few inputs that together reach every kind of coach step. */
function coachActions() {
  const rich = buildCoach(
    coachInput({
      keywords: [
        kw('a', 'water', { change: { kind: 'down', from: 2, to: 9, delta: 7 } }),
        kw('b', 'habit', { change: { kind: 'dropped', from: 4, to: null, delta: null } }),
        kw('m', 'agua', { country: 'mx', locale: 'es-MX' }),
        kw('n', 'sleep', { state: 'not_ranked', rank: null }),
      ],
      lastCheckAt: NOW - 10 * 86_400_000,
      competitorsAbove: [
        { keywordId: 'a', competitorId: 'c', competitorName: 'Rival', competitorRank: 1 },
        { keywordId: 'n', competitorId: 'c', competitorName: 'Rival', competitorRank: 2 },
      ],
      listingLocales: [
        {
          locale: 'en-US',
          fields: { title: 'Water Tracker', subtitle: 'Drink water', keywords: 'tracker, hydration,,Tracker' },
        },
        { locale: 'de-DE', fields: { title: 'Wasser', subtitle: 'x', keywords: '' } },
      ],
      limit: 20,
    }),
  );
  const none = buildCoach(coachInput({}));
  const unchecked = buildCoach(coachInput({ keywords: [kw('a', 'water', { lastCheckedAt: null })], lastCheckAt: null }));
  const play = buildCoach(
    coachInput({
      platform: 'android',
      keywords: [kw('a', 'water'), kw('m', 'agua', { country: 'mx', locale: 'es-MX' })],
      listingLocales: [{ locale: 'en-US', fields: { title: 'Water', description: 'x' } }],
      limit: 20,
    }),
  );
  return [...rich, ...none, ...unchecked, ...play];
}

test('core text: every key core emits for the coach is known to the web', () => {
  const actions = coachActions();
  const kinds = new Set(actions.map((a) => a.kind));
  for (const kind of ['track_keywords', 'check_ranks', 'rank_dropped', 'not_in_listing', 'competitor_above', 'keyword_field_waste', 'unused_characters', 'untapped_locale']) {
    assert.equal(kinds.has(kind as never), true, kind);
  }
  for (const a of actions) {
    const texts: CoreText[] = [a.titleText, a.detailText, a.linkText, ...a.itemTexts];
    assert.equal(a.itemTexts.length, a.items.length, a.kind);
    for (const text of texts) assert.equal(knowsCoreText(text), true, `${a.kind}: ${text.key}`);
  }
});

test('core text: in English the key and parameters give the sentence core wrote', () => {
  const field = (f: string) => ({ title: 'Name', subtitle: 'Subtitle', keywords: 'Keyword field' })[f] ?? f;
  for (const a of coachActions()) {
    const w = coachWords(a, field);
    assert.equal(w.title, a.title, a.kind);
    assert.equal(w.detail, a.detail, a.kind);
    assert.equal(w.linkLabel, a.link.label, a.kind);
    // The field word of "room left" lines depends on the platform (the screen passes it); the other lines are exact.
    if (a.kind !== 'unused_characters') assert.deepEqual(w.items, a.items, a.kind);
    else assert.equal(w.items.length, a.items.length);
  }
});

test('core text: the coach reads in French and falls back to English for an unknown key', () => {
  const actions = coachActions();
  useLocale('fr');
  try {
    const dropped = actions.find((a) => a.kind === 'rank_dropped');
    assert.ok(dropped);
    const w = coachWords(dropped, (f) => f);
    assert.equal(w.title, '2 mots-clés ont perdu des places');
    assert.equal(w.linkLabel, 'Ouvrir les mots-clés');
    assert.match(w.items.join('|'), /de 2 à 9/);
    const unused = actions.find((a) => a.kind === 'unused_characters');
    assert.ok(unused);
    assert.match(coachWords(unused, (f) => `<${f}>`).items[0] as string, /<(title|subtitle|keywords)>/);
    for (const a of actions) {
      const words = coachWords(a, (f) => f);
      assert.doesNotMatch([words.title, words.detail, words.linkLabel, ...words.items].join(' '), /\{\{|core:/, a.kind);
    }
    const old = { ...dropped, titleText: { key: 'coach.nope', params: {} }, itemTexts: [] };
    assert.equal(coachWords(old, (f) => f).title, dropped.title);
  } finally {
    useLocale('en');
  }
});

test('core text: the rollout comparison, rules, templates and keyword reasons', () => {
  const steps = [
    { id: 'a', percent: 5, status: 'done' as const },
    { id: 'b', percent: 20, status: 'done' as const },
    { id: 'c', percent: 50, status: 'planned' as const },
  ].map((s) => ({ ...s, plannedAt: null, note: null, doneAt: null, doneBy: null, doneSource: null, due: false }));
  const play = { platform: 'android' as const, rawState: 'inProgress', syncedAt: 1 };
  const comparisons = [
    compareRollout(steps, storeRollout({ ...play, status: 'rolling_out', fraction: 0.2 })),
    compareRollout(steps, storeRollout({ ...play, status: 'rolling_out', fraction: 0.5 })),
    compareRollout(steps, storeRollout({ ...play, status: 'rolling_out', fraction: 0.05 })),
    compareRollout(steps, storeRollout({ ...play, status: 'halted', fraction: 0.2 })),
    compareRollout(steps, storeRollout({ ...play, status: 'live', fraction: null })),
    compareRollout(steps, storeRollout({ ...play, status: 'rolling_out', fraction: null })),
    compareRollout(steps, null),
    compareRollout([], storeRollout({ ...play, status: 'rolling_out', fraction: 0.1 })),
  ];
  for (const c of comparisons) {
    assert.equal(knowsCoreText(c.text), true, c.text.key);
    assert.equal(rolloutComparisonMessage(c), c.message);
  }
  const issues = [
    validateRolloutSteps([], { planCreatedAt: 0 }),
    validateRolloutSteps([{ percent: 0, note: 'a\nb' }, { id: 'zz', percent: 5 }, { percent: 5 }], { planCreatedAt: 10 }),
  ].flatMap((r) => (r.ok ? [] : r.issues));
  assert.ok(issues.length >= 5);
  for (const issue of issues) {
    assert.equal(knowsCoreText(issue.text), true, issue.text.key);
    assert.equal(rolloutIssueMessage(issue), issue.message);
  }
  for (const platform of ['ios', 'android'] as const) {
    for (const template of rolloutTemplatesFor(platform)) {
      assert.equal(templateName(template), template.name);
      assert.equal(templateDescription(template), template.description);
    }
  }
  for (const raw of [1, 'a\u0001', '  ', 'x'.repeat(200), '!!!', 'a b c d e f g h i j k l']) {
    const check = checkTerm(raw);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(termReason(check), check.reason);
  }

  useLocale('de');
  try {
    assert.match(rolloutComparisonMessage(comparisons[0] as never), /^Der Store meldet 20\s?%, laut Plan ist Stufe 2 von 3 \(20\s?%\) erledigt: Beides stimmt überein\.$/);
    assert.match(rolloutComparisonMessage(comparisons[1] as never), /dem Plan voraus.*Sie können die nächste Stufe/);
    assert.match(rolloutComparisonMessage(comparisons[3] as never), /Der Store hat die Einführung angehalten\.$/);
    assert.equal(rolloutComparisonMessage(comparisons[6] as never), 'Der Store hat diese Version noch nicht gemeldet.');
    assert.equal(coreMessage({ key: 'rollout.nope', params: {} }, 'English'), 'English');
    const first = issues[0];
    assert.ok(first);
    assert.match(rolloutIssueMessage(first), /^Ein Einführungsplan braucht/);
  } finally {
    useLocale('en');
  }
});

test('core text: Google Play checks and the reason no staged rollout is offered', () => {
  const checks = [
    checkPlayProposal(
      { track: '', releaseName: '', versionCodes: [], notes: [], userFraction: 1.5 },
      { listingLocales: [], trackReleases: [] },
    ),
    checkPlayProposal(
      { track: 'production', releaseName: 'v', versionCodes: ['5', '3', 'x'], notes: [{ locale: 'en-US', text: 'x'.repeat(600) }], userFraction: 1 },
      { listingLocales: ['fr-FR'], trackReleases: [{ status: 'completed', versionCodes: ['5', '9'] }] },
    ),
  ].flat();
  const codes = checks.map((c) => c.code);
  for (const code of ['track_missing', 'codes_missing', 'fraction_out_of_range', 'name_empty', 'code_already_live', 'code_not_newer', 'code_invalid', 'full_rollout', 'notes_over_limit', 'notes_missing'])
    assert.equal(codes.includes(code), true, code);
  for (const c of checks) {
    assert.equal(knowsCoreText(c.text), true, c.text.key);
    assert.equal(playCheckMessage(c), c.message, c.code);
  }
  const offers = [
    rolloutOffer({ mode: 'never', track: 'production', earlierProductionRelease: true }),
    rolloutOffer({ mode: 'auto', track: 'production', earlierProductionRelease: false }),
  ];
  for (const offer of offers) assert.equal(rolloutOfferMessage(offer), offer.message);
  useLocale('es');
  try {
    assert.match(playCheckMessage(checks.find((c) => c.code === 'notes_missing') as never), /No hay notas de la versión para fr-FR/);
    assert.match(rolloutOfferMessage(offers[1] as never), /primer lanzamiento/);
  } finally {
    useLocale('en');
  }
});
