import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiAppContext, AiFlag, AiInsightProposal, AiProposal } from '@kiln/core';
import { aiAcceptAction, can } from '@kiln/core';
import {
  type AiConfig,
  acceptBody,
  acceptButtonLabel,
  acceptedNote,
  acceptLabel,
  aiChanges,
  aiErrorMessage,
  blockedReason,
  flagTexts,
  formFromConfig,
  initialSelection,
  proposalRows,
  suggestAvailability,
  suggestionTitle,
  toggleSelection,
  validateAiForm,
} from './ai/ai.ts';
import {
  auditFieldText,
  basedOnText,
  centsFromText,
  centsInput,
  centsText,
  contextToForm,
  costLine,
  emptyContextForm,
  formToContext,
  healthBasis,
  insightTitle,
  isContextDirty,
  periodText,
  previewFacts,
  previewText,
  sentimentShares,
  tagLine,
  validateContextForm,
} from './ai/insights.ts';
import { ApiError } from './api.ts';

const variants = (): AiProposal => ({
  kind: 'listing_variants',
  locale: 'en-US',
  fields: [
    {
      field: 'subtitle',
      limit: 30,
      unit: 'characters',
      variants: [
        {
          text: 'Plan trips with ease',
          reason: 'short',
          length: 20,
          acceptable: false,
          flags: ['not_stageable'],
        },
        {
          text: 'Offline maps for trips',
          reason: 'clear',
          length: 22,
          acceptable: false,
          flags: ['not_stageable'],
        },
      ],
    },
    {
      field: 'promotional_text',
      limit: 170,
      unit: 'characters',
      variants: [
        { text: 'New: offline mode.', reason: 'news', length: 18, acceptable: true, flags: [] },
        {
          text: 'Go offline with maps.',
          reason: 'benefit',
          length: 21,
          acceptable: true,
          flags: [],
        },
        { text: 'Over', reason: 'x', length: 999, acceptable: false, flags: ['over_limit'] },
      ],
    },
  ],
});

const summary = (): AiInsightProposal => ({
  kind: 'insight',
  insight: 'review_summary',
  period: { days: 30, from: 1, to: 2 },
  reviewCount: 40,
  analysed: 25,
  sentiment: { positive: 10, neutral: 5, negative: 10 },
  overview: 'People like the maps.',
  themes: [],
  notes: [],
});

test('variants become one row per variant, grouped by field, and only one per field is ticked', () => {
  const proposal = variants();
  const rows = proposalRows(proposal);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.group),
    ['subtitle', 'subtitle', 'promotional_text', 'promotional_text', 'promotional_text'],
  );
  assert.deepEqual(
    rows.map((r) => r.variant),
    [0, 1, 0, 1, 2],
  );
  // The subtitle cannot be staged: shown, never selected. The first acceptable variant of the other field starts ticked.
  assert.deepEqual(initialSelection(rows), [2]);
  // Choosing another variant of the same field replaces the choice instead of adding to it.
  assert.deepEqual(toggleSelection(rows, [2], 3, true), [3]);
  // A variant that cannot be accepted is never added.
  assert.deepEqual(toggleSelection(rows, [2], 4, true), [2]);
  assert.match(blockedReason(rows[0]?.flags.map((f) => f.flag) ?? []), /draft push/);
});

test('accepting variants names the field and the position of each choice', () => {
  const proposal = variants();
  const rows = proposalRows(proposal);
  assert.deepEqual(acceptBody(proposal, rows, [3]), {
    choices: [{ field: 'promotional_text', variant: 1 }],
  });
  assert.deepEqual(acceptBody(proposal, rows, []), { choices: [] });
  assert.equal(acceptLabel('listing_variants', 1), 'Stage 1 text');
  assert.equal(suggestionTitle(proposal), 'Text variants · en-US');
});

test('the accept button names the field it stages into, and keyword ideas say Track, not add', () => {
  const proposal = variants();
  const rows = proposalRows(proposal);
  assert.equal(acceptButtonLabel(proposal, rows, [3]), 'Stage in promotional text');
  assert.equal(acceptButtonLabel(proposal, rows, []), 'Stage 0 texts');
  const keywords: AiProposal = {
    kind: 'keywords',
    store: 'app_store',
    country: 'us',
    locale: 'en-US',
    items: [{ term: 'offline maps', reason: 'x', field: 'name', acceptable: true, flags: [] }],
  };
  const krows = proposalRows(keywords);
  assert.equal(acceptButtonLabel(keywords, krows, [0]), 'Track 1 keyword');
  assert.equal(krows[0]?.placement, 'name');
  assert.equal(krows[0]?.note, 'Where it would go: Title (App Store name)');
  const text: AiProposal = {
    kind: 'listing_text',
    locale: 'en-US',
    fields: [
      {
        field: 'keywords',
        text: 'a,b',
        reason: '',
        length: 3,
        limit: 100,
        unit: 'bytes',
        acceptable: true,
        flags: [],
      },
    ],
  };
  assert.equal(acceptButtonLabel(text, proposalRows(text), [0]), 'Stage in keyword field');
});

test('a report has no rows to tick; it is marked as reviewed and says nothing was changed', () => {
  const proposal = summary();
  assert.deepEqual(proposalRows(proposal), []);
  assert.deepEqual(acceptBody(proposal, [], []), {});
  assert.equal(acceptLabel('insight', 0), 'Mark as reviewed');
  assert.match(acceptedNote({ kind: 'insight' }, 'a1').text, /Nothing was changed/);
  assert.equal(acceptedNote({ kind: 'insight' }, 'a1').href, null);
  assert.equal(suggestionTitle(proposal), 'Review summary · last 30 days');
  assert.equal(aiAcceptAction.insight, 'ai.use');
});

test('every flag has a sentence, and the ones that block say why', () => {
  const flags: AiFlag[] = [
    'banned_term',
    'personal_data',
    'risky_promise',
    'unverified_number',
    'brand_term_missing',
  ];
  for (const f of flags) assert.ok(flagTexts[f].text.length > 0, f);
  assert.ok(flagTexts.banned_term.blocks);
  assert.ok(flagTexts.personal_data.blocks);
  assert.equal(flagTexts.risky_promise.blocks, null);
  assert.equal(flagTexts.brand_term_missing.blocks, null);
});

test('a report can be asked for by an ai.use role only, a staged variant needs the stage right', () => {
  const config = {
    state: 'ready',
    usage: { month: 'm', used: 0, budget: 0, remaining: null, runs: 0, resetsAt: 0 },
  } as unknown as AiConfig;
  assert.equal(
    suggestAvailability({ role: 'viewer', config, kind: 'insight' }).visible,
    can('viewer', 'ai.use'),
  );
  assert.equal(suggestAvailability({ role: 'member', config, kind: 'insight' }).enabled, true);
  assert.equal(
    suggestAvailability({ role: 'member', config: null, kind: 'insight' }).visible,
    false,
  );
});

test('the new refusals are fixed sentences', () => {
  const err = (code: string, body: Record<string, unknown> = {}, status = 422) =>
    new ApiError(status, code, 'x', undefined, body);
  assert.match(aiErrorMessage(err('no_reviews')), /no reviews/i);
  assert.match(aiErrorMessage(err('nothing_to_do', {}, 409)), /already has tags/);
  assert.match(aiErrorMessage(err('goal_needed')), /Say what/);
  assert.match(aiErrorMessage(err('no_data')), /not enough stored data/);
  assert.match(aiErrorMessage(err('ai_cost_cap_reached', {}, 429)), /cost cap/);
  const dated = aiErrorMessage(
    err('ai_cost_cap_reached', { resetsAt: Date.UTC(2026, 11, 1) }, 429),
  );
  assert.match(dated, /1 December/);
  // The server's own words are never shown.
  assert.doesNotMatch(
    aiErrorMessage(new ApiError(422, 'goal_needed', 'SECRET SERVER WORDS')),
    /SECRET/,
  );
});

test('review numbers are shown as the server counted them', () => {
  assert.deepEqual(sentimentShares({ positive: 10, neutral: 5, negative: 10 }), {
    positive: 40,
    neutral: 20,
    negative: 40,
  });
  assert.deepEqual(sentimentShares({ positive: 0, neutral: 0, negative: 0 }), {
    positive: 0,
    neutral: 0,
    negative: 0,
  });
  assert.equal(basedOnText(25, 40), 'Based on the newest 25 of 40 reviews.');
  assert.equal(basedOnText(1, 1), 'Based on 1 review.');
  assert.equal(periodText({ days: 1 }), 'last day');
  assert.equal(
    tagLine({ topics: ['crash', 'login'], sentiment: 'negative', severity: 'high' }),
    'Crash, Login · negative · high severity',
  );
  assert.equal(
    tagLine({ topics: ['praise'], sentiment: 'positive', severity: 'none' }),
    'Praise · positive',
  );
  assert.equal(
    insightTitle({
      ...(summary() as Extract<AiInsightProposal, { insight: 'review_summary' }>),
      insight: 'review_summary',
    }),
    'Review summary · last 30 days',
  );
});

test('audit and health lines come from counted numbers', () => {
  assert.equal(
    auditFieldText({
      field: 'subtitle',
      label: 'Subtitle',
      length: 16,
      limit: 30,
      unit: 'characters',
      percent: 53.3,
      empty: false,
    }),
    '16 of 30 characters (53%)',
  );
  assert.equal(
    auditFieldText({
      field: 'keywords',
      label: 'Keywords',
      length: 0,
      limit: 100,
      unit: 'bytes',
      percent: 0,
      empty: true,
    }),
    'Empty (0 of 100 bytes)',
  );
  assert.equal(
    healthBasis({ keywords: 1, ranked: 0, coachSteps: 2, competitors: 0, analyticsSeries: 3 }),
    'Based on 1 keyword (0 with a rank), 2 coach steps, store analytics.',
  );
});

test('money is whole cents and typed as dollars', () => {
  assert.equal(centsText(1234), '$12.34');
  assert.equal(centsText(5), '$0.05');
  assert.equal(centsText(100000), '$1,000.00');
  assert.equal(centsFromText('12.5'), 1250);
  assert.equal(centsFromText('$3'), 300);
  assert.equal(centsFromText(''), 0);
  assert.equal(centsFromText('1.234'), null);
  assert.equal(centsFromText('abc'), null);
  assert.equal(centsInput(0), '0');
  assert.equal(centsInput(1250), '12.5');
  assert.equal(centsInput(300), '3');
  assert.equal(centsInput(305), '3.05');
  assert.equal(costLine({ pricesSet: false }), null);
  assert.match(
    costLine({ pricesSet: true, estimatedCostCents: 250, costCapCents: 1000 }) ?? '',
    /\$2\.50 of \$10\.00.*estimate/,
  );
});

test('the cost and warning settings are validated and only the changed ones are sent', () => {
  const cfg = {
    settings: {
      enabled: true,
      provider: 'anthropic',
      model: 'm',
      baseUrl: null,
      baseUrlSet: false,
      monthlyTokenBudget: 1000,
      maxOutputTokens: 1,
      maxInputTokens: 1,
      softWarnPercent: 80,
      priceInputCentsPerMTok: 0,
      priceOutputCentsPerMTok: 0,
      monthlyCostCapCents: 0,
    },
    providers: [
      {
        id: 'anthropic',
        label: 'A',
        credentialKind: 'ai_anthropic',
        credentialRequired: true,
        needsUrl: false,
        privacy: 'p',
        credentialPresent: true,
      },
    ],
    limits: {},
  } as unknown as AiConfig;
  const form = formFromConfig(cfg);
  assert.equal(form.softWarn, '80');
  assert.deepEqual(aiChanges(cfg, form), {});
  assert.deepEqual(
    aiChanges(cfg, { ...form, softWarn: '90', priceIn: '3', priceOut: '15', costCap: '25' }),
    {
      softWarnPercent: 90,
      priceInputCentsPerMTok: 300,
      priceOutputCentsPerMTok: 1500,
      monthlyCostCapCents: 2500,
    },
  );
  const errors = validateAiForm({ ...form, softWarn: '150', priceIn: 'x', costCap: '-1' }, cfg);
  assert.ok(errors.softWarn);
  assert.ok(errors.priceIn);
  assert.ok(errors.costCap);
  assert.equal(validateAiForm(form, cfg).softWarn, undefined);
});

test('the AI context form: lines in, lists out, and the same checks as the server', () => {
  const empty = emptyContextForm();
  assert.equal(isContextDirty(formToContext(empty), empty), false);
  const form = {
    ...empty,
    about: ' A trip planner. ',
    bannedWords: 'cheap, free\nbest\n',
    brandTerms: 'Wanderly',
    doList: "Be brief, always\nAnswer in the reviewer's language",
    tone: 'warm',
  };
  const context = formToContext(form);
  assert.equal(context.about, 'A trip planner.');
  assert.deepEqual(context.bannedWords, ['cheap', 'free', 'best']);
  // Rules are sentences: only a new line separates them, a comma does not.
  assert.deepEqual(context.doList, ['Be brief, always', "Answer in the reviewer's language"]);
  const checked = validateContextForm(form);
  assert.equal(checked.ok, true);
  const saved: AiAppContext = context;
  assert.equal(isContextDirty(saved, contextToForm(saved)), false);
  assert.equal(isContextDirty(saved, { ...contextToForm(saved), tone: 'cold' }), true);
  const tooLong = validateContextForm({ ...empty, about: 'x'.repeat(601) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.ok(tooLong.errors.about);
});

test('the preview shows the exact data, cut for the view only, with the numbers', () => {
  const small = previewText({ a: 1 });
  assert.equal(small.cut, false);
  assert.match(small.text, /"a": 1/);
  const big = previewText({ text: 'x'.repeat(100) }, 50);
  assert.equal(big.cut, true);
  assert.equal(big.text.length, 50);
  assert.match(
    previewFacts({
      estimatedInputTokens: 1200,
      maxOutputTokens: 2000,
      includesAppContext: true,
      model: 'm1',
    }),
    /1,200 tokens.*2,000.*is included/,
  );
  assert.match(
    previewFacts({
      estimatedInputTokens: 5,
      maxOutputTokens: 5,
      includesAppContext: false,
      model: 'm1',
    }),
    /not included/,
  );
});
