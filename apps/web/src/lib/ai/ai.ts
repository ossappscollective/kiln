import {
  type AiAcceptedRef,
  type AiAppContext,
  type AiFlag,
  type AiProposal,
  type AiProposalKind,
  type AiProvider,
  type AiSuggestionView,
  aiAcceptAction,
  buildSecret,
  byFamily,
  can,
  checkSecret,
  type Platform,
  type Role,
  type StoreFamily,
  storeFamilyOf,
} from '@kiln/core';
import { ApiError } from '../api.ts';
import { appAddress, appReviewsHref, type PlatformScope } from '../app-scope.ts';
import { asoViewHref } from '../aso/aso.ts';
import { formatDate, formatList, formatNumber } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { platformLabel } from '../portfolio.ts';
import { centsFromText, centsInput, insightTitle } from './insights.ts';
import { placementLine, stageInLabel } from './placement.ts';

/**
 * AI assistance in the web (docs/api/ai.md, docs/adr/0016-ai-foundation.md): the shapes of the API and the pure logic of the screens.
 *
 * The rule the screens follow: a run makes a SUGGESTION (a proposal) and changes nothing. A person looks at it and accepts it, and
 * accepting goes through a mechanism that already exists (track keywords, stage a text, save a reply draft). Nothing here pushes,
 * submits, publishes, releases or sends. Everything a model wrote (`reason`, `text`) is shown as plain text, never as markup, and the
 * provider's own words are never shown: errors are sentences chosen here from fixed codes. Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// The shapes of the API

export type AiState = 'ready' | 'off_server' | 'off_workspace' | 'not_configured';
export type AiReason =
  | 'no_model'
  | 'no_credential'
  | 'no_url'
  | 'credential_unreadable'
  | 'bad_url';

export type AiProviderView = {
  id: AiProvider;
  label: string;
  credentialKind: 'ai_anthropic' | 'ai_openai' | 'ai_openai_compatible';
  credentialRequired: boolean;
  needsUrl: boolean;
  privacy: string;
  credentialPresent: boolean;
};

/** A soft warning (`soft`: runs still work) or the limit (`limit`: the next run is refused), written by the server. */
export type AiUsageWarning = {
  kind: 'tokens' | 'cost';
  level: 'soft' | 'limit';
  percent: number;
  message: string;
};
export type AiTaskUsage = {
  task: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
};

export type AiUsage = {
  month: string;
  used: number;
  budget: number;
  remaining: number | null;
  runs: number;
  resetsAt: number;
  /** In whole cents, worked out from the prices an admin typed. 0 when no prices are set. */
  estimatedCostCents?: number;
  costCapCents?: number;
  pricesSet?: boolean;
  byTask?: AiTaskUsage[];
  warning?: AiUsageWarning | null;
};

export type AiConfig = {
  state: AiState;
  reason?: AiReason;
  server: { enabled: boolean; allowPrivateUrls: boolean };
  settings: {
    enabled: boolean;
    provider: AiProvider;
    model: string;
    /** Only admins see the address; others get null (see `baseUrlSet`). */
    baseUrl: string | null;
    baseUrlSet: boolean;
    monthlyTokenBudget: number;
    maxOutputTokens: number;
    maxInputTokens: number;
    /** From this share of a monthly limit on, a run shows a warning (0: never). Runs still work until 100. */
    softWarnPercent?: number;
    /** Whole cents per million tokens, typed by an admin (0: not set). Only used to estimate the cost. */
    priceInputCentsPerMTok?: number;
    priceOutputCentsPerMTok?: number;
    /** A monthly cost cap in whole cents (0: none). Unlike the soft warning it refuses a run. */
    monthlyCostCapCents?: number;
  };
  defaults: {
    monthlyTokenBudget: number;
    maxOutputTokens: number;
    maxInputTokens: number;
    softWarnPercent?: number;
    priceInputCentsPerMTok?: number;
    priceOutputCentsPerMTok?: number;
    monthlyCostCapCents?: number;
  };
  /** The settings an operator fixed in the server's environment. */
  overridden: string[];
  providers: AiProviderView[];
  usage: AiUsage;
  limits: Record<string, number>;
  canManage: boolean;
};

export type AiScopeField = {
  name: string;
  required: boolean;
  description: string;
  values?: string[];
};
export type AiTaskView = {
  id: string;
  version: number;
  label: string;
  description: string;
  status: 'ready' | 'planned';
  proposalKind: AiProposalKind | null;
  acceptAction: string | null;
  scope: AiScopeField[];
  disclosure: { sends: string[]; neverSends: string[] };
};
export type AiTasksResponse = {
  tasks: AiTaskView[];
  state: AiState;
  provider: { id: AiProvider; label: string; privacy: string } | null;
};

export type AiRunBody = {
  appId: string;
  locale?: string;
  country?: string;
  fields?: string[];
  goal?: string;
  reviewId?: string;
  tone?: 'friendly' | 'neutral' | 'apologetic';
  replyLanguage?: string;
  /** Review summary: the language it is written in, and a new one even when the stored summary has the same reviews. */
  outputLanguage?: 'en' | 'fr' | 'es' | 'de';
  refresh?: boolean;
  /** Reviews of the last `days` days (summary, what to fix next). */
  days?: number;
  /** How many reviews to tag in one run (classify). */
  limit?: number;
  reviewIds?: string[];
  /** The language to translate from (`locale` is the one to translate to). */
  sourceLocale?: string;
  /** How many variants per field. */
  count?: number;
};

export type AiAcceptBody = {
  items?: number[];
  fields?: string[];
  choices?: { field: string; variant: number }[];
  replace?: boolean;
};

/** A run answers with the suggestion and, near a monthly limit, a warning. */
export type AiRunResult = { suggestion: AiSuggestionView; warning?: AiUsageWarning | null; cached?: boolean };

/** POST /ai/tasks/:id/preview: exactly what a run would send, built from stored data. Nothing is sent to a provider. */
export type AiPreview = {
  task: { id: string; version: number };
  input: unknown;
  system: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  includesAppContext: boolean;
  provider: AiProvider;
  model: string;
};

/** GET and PUT /apps/:id/ai/context. */
export type AiAppContextView = {
  context: AiAppContext;
  updatedAt: number | null;
  updatedBy: string | null;
  canEdit: boolean;
};

/** What the assistant tagged a review with (advisory). */
export type AiReviewTagView = {
  reviewId: string;
  topics: string[];
  sentiment: string;
  severity: string;
  language: string | null;
  needsReply: boolean;
};
export type AiAcceptResult = { suggestion: AiSuggestionView; result: AiAcceptedRef };

/** What PUT /ai/config takes: any of these, `null` resets one to its default. */
export type AiSettingsChanges = {
  enabled?: boolean | null;
  provider?: AiProvider | null;
  model?: string | null;
  baseUrl?: string | null;
  monthlyTokenBudget?: number | null;
  maxOutputTokens?: number | null;
  maxInputTokens?: number | null;
  softWarnPercent?: number | null;
  priceInputCentsPerMTok?: number | null;
  priceOutputCentsPerMTok?: number | null;
  monthlyCostCapCents?: number | null;
};

/** A model a provider offers (POST /ai/models). */
export type AiModel = { id: string; label?: string };
export type AiModelsResponse = {
  models: AiModel[];
  /** `provider`: the server answered a list. `fallback`: it could not, and `models` is a short fixed list (empty for a compatible server). */
  source: 'provider' | 'fallback';
  reason?: 'no_credential' | 'list_unavailable';
};
/** The body of POST /ai/models. `apiKey` is a key typed in the form and not saved yet: used for this one call only. */
export type AiModelsBody = { provider: AiProvider; baseUrl?: string; apiKey?: string };

export type AiTestOutcome =
  | { ok: true; provider: AiProvider; model: string }
  | {
      ok: false;
      provider?: AiProvider;
      kind?: string;
      message?: string;
      reason?: string;
      sample?: string;
    };

// ---------------------------------------------------------------------------------------------
// Where the feature stands, in words

export const AI_ENV = 'KILN_AI_ENABLED';

const offServerText = (): string => t('ai:state.offServer', { env: AI_ENV });

export type StateInfo = { tone: 'ok' | 'info' | 'warn'; label: string; message: string };

const NOT_CONFIGURED_ADMIN: Record<AiReason, string> = {
  no_model: k('ai:setup.noModel'),
  no_credential: k('ai:setup.noCredential'),
  no_url: k('ai:setup.noUrl'),
  credential_unreadable: k('ai:setup.credentialUnreadable'),
  bad_url: k('ai:setup.badUrl'),
};

/** The one sentence that says where AI assistance stands. `canManage` decides whether it says what to do or who can. */
export function aiStateInfo(
  config: Pick<AiConfig, 'state' | 'reason' | 'canManage' | 'settings'> & {
    providers?: AiProviderView[];
  },
): StateInfo {
  switch (config.state) {
    case 'off_server':
      return {
        tone: 'info',
        label: t('ai:state.offServerLabel'),
        message: offServerText(),
      };
    case 'off_workspace':
      return {
        tone: 'info',
        label: t('ai:state.offLabel'),
        message: config.canManage ? t('ai:state.offWorkspaceAdmin') : t('ai:state.offWorkspace'),
      };
    case 'not_configured': {
      const reason = config.reason ?? 'no_model';
      return {
        tone: 'warn',
        label: t('ai:state.notSetUpLabel'),
        message: config.canManage ? t(NOT_CONFIGURED_ADMIN[reason]) : t('ai:state.notSetUpMember'),
      };
    }
    default: {
      const label = config.providers?.find((p) => p.id === config.settings.provider)?.label;
      return {
        tone: 'ok',
        label: t('ai:state.readyLabel'),
        message: label ? t('ai:state.readyUsing', { provider: label }) : t('ai:state.ready'),
      };
    }
  }
}

/** "December 1" / "1 décembre": the day the monthly limit starts again (UTC), in the language of the app. */
export function resetText(resetsAt: number): string {
  return formatDate(resetsAt, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export const countText = (n: number): string => formatNumber(n);

/** "120,000 of 500,000 used this month. Starts again on 1 December." */
export function usageText(usage: Pick<AiUsage, 'used' | 'budget' | 'resetsAt'>): string {
  if (usage.budget <= 0) return t('ai:usage.usedNoLimit', { used: countText(usage.used) });
  return t('ai:usage.usedOf', {
    used: countText(usage.used),
    budget: countText(usage.budget),
    date: resetText(usage.resetsAt),
  });
}

/** 0 to 1, or null when there is no limit. */
export function usageFraction(usage: Pick<AiUsage, 'used' | 'budget'>): number | null {
  if (usage.budget <= 0) return null;
  return Math.max(0, Math.min(1, usage.used / usage.budget));
}

/** The monthly limit is used up: a run would be refused before anything is sent. */
export const budgetUsedUp = (usage: Pick<AiUsage, 'budget' | 'remaining'>): boolean =>
  usage.budget > 0 && usage.remaining !== null && usage.remaining <= 0;

/** "Text you choose is sent to Anthropic (Claude)." Says who receives the data, before anything is sent. */
export function providerSentence(provider: Pick<AiProviderView, 'id' | 'label'> | null): string {
  if (provider === null) return t('ai:provider.sentToChosen');
  if (provider.id === 'openai_compatible') return t('ai:provider.sentToServer');
  return t('ai:provider.sentTo', { provider: provider.label });
}

// ---------------------------------------------------------------------------------------------
// Who sees a Suggest control, and when it is disabled

export type SuggestAvailability = {
  /** False: draw nothing (AI is off, still unknown, or the role cannot use or accept this). Quiet by default. */
  visible: boolean;
  enabled: boolean;
  /** Why it is disabled, in a sentence. */
  reason: string | null;
};

const HIDDEN: SuggestAvailability = { visible: false, enabled: false, reason: null };

/**
 * A Suggest control is hidden when AI is off (either switch), when the role lacks `ai.use` or the right of what accepting would
 * create, and while the configuration is not known. It is visible but disabled, with the reason, when AI is switched on but not
 * ready or the monthly limit is used up.
 */
export function suggestAvailability(input: {
  role: Role;
  config: AiConfig | null;
  kind: AiProposalKind;
}): SuggestAvailability {
  const { role, config, kind } = input;
  if (!can(role, 'ai.use') || !can(role, aiAcceptAction[kind])) return HIDDEN;
  if (config === null) return HIDDEN;
  if (config.state === 'off_server' || config.state === 'off_workspace') return HIDDEN;
  if (config.state === 'not_configured')
    return { visible: true, enabled: false, reason: aiStateInfo(config).message };
  if (budgetUsedUp(config.usage)) {
    return {
      visible: true,
      enabled: false,
      reason: t('ai:availability.limitUsedUp', { date: resetText(config.usage.resetsAt) }),
    };
  }
  return { visible: true, enabled: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// The disclosure before a first run

/** What a storage needs for the "don't ask again" choice (a `Storage`, or a stand-in in tests). */
export type DisclosureStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const DISCLOSURE_PREFIX = 'kiln.ai.skip.';
export const disclosureKey = (taskId: string): string => `${DISCLOSURE_PREFIX}${taskId}`;

/**
 * What a "don't ask again" is valid for: this version of the task (its disclosure may have changed) and this provider (who receives
 * the data may have changed). A different stamp asks again.
 */
export const disclosureStamp = (task: { version: number }, providerId: string | null): string =>
  `${task.version}:${providerId ?? ''}`;

export type DisclosureGate = {
  /** True when the person must see what is sent before this run. */
  needs(task: { id: string; version: number }, providerId: string | null): boolean;
  /** The person saw it and went on. `remember` is "Don't ask again for this task". */
  confirm(
    task: { id: string; version: number },
    providerId: string | null,
    remember: boolean,
  ): void;
  /** Forgets what was confirmed in this session (not the stored choice). */
  reset(): void;
};

/**
 * Once per task per session, unless the person chose "Don't ask again" (kept in localStorage, which can be missing or refuse: every
 * access is guarded and a failure just means the question is asked again).
 */
export function createDisclosureGate(storage: () => DisclosureStorage | null): DisclosureGate {
  const session = new Map<string, string>();
  const read = (taskId: string): string | null => {
    try {
      return storage()?.getItem(disclosureKey(taskId)) ?? null;
    } catch {
      return null;
    }
  };
  return {
    needs(task, providerId) {
      const stamp = disclosureStamp(task, providerId);
      if (session.get(task.id) === stamp) return false;
      return read(task.id) !== stamp;
    },
    confirm(task, providerId, remember) {
      const stamp = disclosureStamp(task, providerId);
      session.set(task.id, stamp);
      if (!remember) return;
      try {
        storage()?.setItem(disclosureKey(task.id), stamp);
      } catch {
        // Storage may be full or blocked: the session memory still holds.
      }
    },
    reset() {
      session.clear();
    },
  };
}

function browserStorage(): DisclosureStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const disclosureGate: DisclosureGate = createDisclosureGate(browserStorage);

// ---------------------------------------------------------------------------------------------
// Proposals as rows

export type FlagTone = 'info' | 'warn' | 'bad';
export type FlagInfo = { flag: AiFlag; text: string; tone: FlagTone };

/** Keys of the texts, not the texts: `flagInfos` and `blockedReason` translate where the flag is drawn. */
export const flagTexts: Record<AiFlag, { text: string; tone: FlagTone; blocks: string | null }> = {
  already_tracked: {
    text: k('ai:flag.alreadyTracked'),
    tone: 'info',
    blocks: k('ai:blocked.alreadyTracked'),
  },
  duplicate: { text: k('ai:flag.duplicate'), tone: 'info', blocks: k('ai:blocked.duplicate') },
  invalid_term: {
    text: k('ai:flag.invalidTerm'),
    tone: 'bad',
    blocks: k('ai:blocked.invalidTerm'),
  },
  field_not_for_store: { text: k('ai:flag.fieldNotForStore'), tone: 'info', blocks: null },
  over_limit: { text: k('ai:flag.overLimit'), tone: 'bad', blocks: k('ai:blocked.overLimit') },
  trimmed: { text: k('ai:flag.trimmed'), tone: 'warn', blocks: null },
  unchanged: { text: k('ai:flag.unchanged'), tone: 'info', blocks: k('ai:blocked.unchanged') },
  not_stageable: {
    text: k('ai:flag.notStageable'),
    tone: 'bad',
    blocks: k('ai:blocked.notStageable'),
  },
  empty: { text: k('ai:flag.empty'), tone: 'bad', blocks: k('ai:blocked.empty') },
  cleaned: { text: k('ai:flag.cleaned'), tone: 'warn', blocks: null },
  markup: { text: k('ai:flag.markup'), tone: 'bad', blocks: k('ai:blocked.markup') },
  banned_term: { text: k('ai:flag.bannedTerm'), tone: 'bad', blocks: k('ai:blocked.bannedTerm') },
  personal_data: {
    text: k('ai:flag.personalData'),
    tone: 'bad',
    blocks: k('ai:blocked.personalData'),
  },
  risky_promise: { text: k('ai:flag.riskyPromise'), tone: 'warn', blocks: null },
  unverified_number: { text: k('ai:flag.unverifiedNumber'), tone: 'warn', blocks: null },
  brand_term_missing: { text: k('ai:flag.brandTermMissing'), tone: 'warn', blocks: null },
};

export const flagInfos = (flags: readonly AiFlag[]): FlagInfo[] =>
  flags.map((flag) => ({
    flag,
    text: flagTexts[flag] ? t(flagTexts[flag].text) : flag,
    tone: flagTexts[flag]?.tone ?? 'info',
  }));

/** Why an item cannot be accepted, from its flags. */
export function blockedReason(flags: readonly AiFlag[]): string {
  for (const flag of flags) {
    const blocks = flagTexts[flag]?.blocks;
    if (blocks) return t('ai:blocked.prefix', { reason: t(blocks) });
  }
  return t('ai:blocked.plain');
}

const LISTING_LABELS: Record<string, string> = {
  name: k('ai:field.name'),
  subtitle: k('ai:field.subtitle'),
  description: k('ai:field.description'),
  keywords: k('ai:field.keywords'),
  promotional_text: k('ai:field.promotionalText'),
  title: k('ai:field.title'),
  short_description: k('ai:field.shortDescription'),
  full_description: k('ai:field.fullDescription'),
};
export const listingFieldLabel = (field: string): string => {
  const key = LISTING_LABELS[field];
  return key ? t(key) : field;
};

/** The fields the "listing_improve" task offers (the ones a draft push can write), per platform. */
const IMPROVABLE: Record<StoreFamily, readonly string[]> = {
  apple: ['description', 'keywords', 'promotional_text'],
  google: ['title', 'short_description', 'full_description'],
};
export const canImproveField = (platform: Platform, field: string): boolean =>
  IMPROVABLE[storeFamilyOf(platform)].indexOf(field) !== -1;

export type RowMeter = {
  used: number;
  limit: number;
  remaining: number;
  over: boolean;
  unit: 'characters' | 'bytes';
  percent: number;
};

/** The numbers of a char-limit meter for a text of `used` against `limit` (the shape the keyword budget meter draws). */
export function meterFor(used: number, limit: number, unit: 'characters' | 'bytes'): RowMeter {
  const remaining = limit - used;
  return {
    used,
    limit,
    remaining,
    over: remaining < 0,
    unit,
    percent: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0,
  };
}

export type ProposalRow = {
  /** Its position in the proposal (`items` of a keyword idea list, `fields` of a listing text). */
  index: number;
  /** A stable key: the term, the field or `reply`. */
  key: string;
  title: string;
  /** The text a person would get (listing text, a reply), or null (keywords). Plain text. */
  text: string | null;
  /** What the model said about it. Plain text. */
  reason: string;
  /** A short extra line (the field a keyword is meant for). */
  note: string | null;
  flags: FlagInfo[];
  acceptable: boolean;
  /** Why it cannot be accepted, or null. */
  blocked: string | null;
  meter: RowMeter | null;
  /** Rows with the same group are alternatives: at most one of them is chosen (the variants of one listing field). Null: independent. */
  group: string | null;
  /** The position inside its group, for the `choices` of an accept. */
  variant: number | null;
  /** A keyword idea: the listing field it would go in (a suggestion only), or null. Other rows: null. */
  placement: string | null;
};

/** The proposal of a suggestion as rows for the screen. Every text is data: the screen shows it as text only. */
export function proposalRows(proposal: AiProposal): ProposalRow[] {
  switch (proposal.kind) {
    case 'keywords':
      return proposal.items.map((item, index) => ({
        index,
        key: item.term,
        title: item.term,
        text: null,
        reason: item.reason,
        note: placementLine(item.field),
        flags: flagInfos(item.flags),
        acceptable: item.acceptable,
        blocked: item.acceptable ? null : blockedReason(item.flags),
        meter: null,
        group: null,
        variant: null,
        placement: item.field,
      }));
    case 'listing_text':
      return proposal.fields.map((f, index) => ({
        index,
        key: f.field,
        title: listingFieldLabel(f.field),
        text: f.text,
        reason: f.reason,
        note: null,
        flags: flagInfos(f.flags),
        acceptable: f.acceptable,
        blocked: f.acceptable ? null : blockedReason(f.flags),
        meter: f.limit === null ? null : meterFor(f.length, f.limit, f.unit),
        group: null,
        variant: null,
        placement: null,
      }));
    case 'listing_variants': {
      const out: ProposalRow[] = [];
      for (const f of proposal.fields) {
        f.variants.forEach((v, n) => {
          out.push({
            index: out.length,
            key: `${f.field}#${n}`,
            title: t('ai:row.variantTitle', { field: listingFieldLabel(f.field), n: n + 1 }),
            text: v.text,
            reason: v.reason,
            note: null,
            flags: flagInfos(v.flags),
            acceptable: v.acceptable,
            blocked: v.acceptable ? null : blockedReason(v.flags),
            meter: f.limit === null ? null : meterFor(v.length, f.limit, f.unit),
            group: f.field,
            variant: n,
            placement: null,
          });
        });
      }
      return out;
    }
    case 'insight':
      // A report has nothing to tick: it is read, and marked as reviewed.
      return [];
    case 'reply_draft':
      return [
        {
          index: 0,
          key: 'reply',
          title: t('ai:row.reply'),
          text: proposal.text,
          reason: '',
          note: null,
          flags: flagInfos(proposal.flags),
          acceptable: proposal.acceptable,
          blocked: proposal.acceptable ? null : blockedReason(proposal.flags),
          meter: meterFor(proposal.length, proposal.limit, 'characters'),
          group: null,
          variant: null,
          placement: null,
        },
      ];
  }
}

export const acceptableIndexes = (rows: readonly ProposalRow[]): number[] =>
  rows.filter((r) => r.acceptable).map((r) => r.index);

/** Everything that can be accepted is selected to start with (the first acceptable alternative of each group); the rest is never selected. */
export function initialSelection(rows: readonly ProposalRow[]): number[] {
  const seen: Record<string, boolean> = {};
  const out: number[] = [];
  for (const r of rows) {
    if (!r.acceptable) continue;
    if (r.group !== null) {
      if (seen[r.group]) continue;
      seen[r.group] = true;
    }
    out.push(r.index);
  }
  return out;
}

/** Switches one row of a selection. A row that cannot be accepted is never added. */
export function toggleSelection(
  rows: readonly ProposalRow[],
  selected: readonly number[],
  index: number,
  on: boolean,
): number[] {
  const ok = acceptableIndexes(rows);
  const group = rows.find((r) => r.index === index)?.group ?? null;
  // Choosing one alternative of a group (a variant of a field) replaces the one chosen before.
  const sameGroup = (i: number): boolean =>
    group !== null && rows.some((r) => r.index === i && r.group === group);
  const addable = on && ok.indexOf(index) !== -1;
  const next = selected.filter(
    (i) => i !== index && ok.indexOf(i) !== -1 && !(addable && sameGroup(i)),
  );
  if (addable) next.push(index);
  return next.sort((a, b) => a - b);
}

/**
 * The body of the accept call for the chosen rows. It names exactly what the person ticked (never "everything"), so what is
 * accepted is what was on the screen. The server closes the suggestion on the first accept: rows not chosen are not kept for later.
 */
export function acceptBody(
  proposal: AiProposal,
  rows: readonly ProposalRow[],
  selected: readonly number[],
  replace = false,
): AiAcceptBody {
  const chosen = rows.filter((r) => r.acceptable && selected.indexOf(r.index) !== -1);
  const body: AiAcceptBody = {};
  if (proposal.kind === 'keywords') body.items = chosen.map((r) => r.index);
  else if (proposal.kind === 'listing_text') body.fields = chosen.map((r) => r.key);
  else if (proposal.kind === 'listing_variants') {
    body.choices = chosen
      .filter((r) => r.group !== null && r.variant !== null)
      .map((r) => ({ field: r.group as string, variant: r.variant as number }));
  }
  if (replace) body.replace = true;
  return body;
}

/** The label of the accept button: it says what accepting does ("Track 2 keywords"), not just "Accept". */
export function acceptLabel(kind: AiProposalKind, chosen: number): string {
  switch (kind) {
    case 'keywords':
      return t('ai:accept.trackKeywords', { count: chosen });
    case 'listing_text':
      return t('ai:accept.stageTexts', { count: chosen });
    case 'reply_draft':
      return t('ai:accept.saveReply');
    case 'listing_variants':
      return t('ai:accept.stageTexts', { count: chosen });
    case 'insight':
      return t('ai:accept.markReviewed');
  }
}

/**
 * The label of the accept button of a card: for one chosen text it names the field ("Stage in keyword field"), so a person sees that
 * accepting STAGES that text; for keyword ideas it says "Track", never "add to the listing".
 */
export function acceptButtonLabel(
  proposal: AiProposal,
  rows: readonly ProposalRow[],
  selected: readonly number[],
): string {
  const chosen = rows.filter((r) => r.acceptable && selected.indexOf(r.index) !== -1);
  const only = chosen.length === 1 ? (chosen[0] as ProposalRow) : null;
  if (only !== null && (proposal.kind === 'listing_text' || proposal.kind === 'listing_variants')) {
    return stageInLabel(only.group ?? only.key);
  }
  return acceptLabel(proposal.kind, chosen.length);
}

// ---------------------------------------------------------------------------------------------
// What accepting did, and where to look

/** The label of the replace button after a refused accept ("Replace and stage in title"): the action in lower case at its start. */
export function replaceButtonLabel(
  proposal: AiProposal,
  rows: readonly ProposalRow[],
  selected: readonly number[],
): string {
  const action = acceptButtonLabel(proposal, rows, selected);
  return t('ai:accept.replaceAnd', { action: action.charAt(0).toLowerCase() + action.slice(1) });
}

export type AcceptedNote = { text: string; href: string | null; linkLabel: string | null };

const unitList = (items: readonly string[]): string => formatList(items, { type: 'unit' });

/**
 * The sentence after an accept and the link to where the result lives (ids only came back, never text). `appPlatform` is the platform
 * of the app the suggestion belongs to: a keyword is tracked for that app and market, so the sentence names them ("Added 8 keywords to
 * iOS · en-US") and the link opens that platform, whatever scope the page was in.
 */
export function acceptedNote(
  result: AiAcceptedRef,
  appId: string,
  platform: PlatformScope | null = null,
  appPlatform: Platform | null = null,
): AcceptedNote {
  switch (result.kind) {
    case 'keywords': {
      const where = [appPlatform ? platformLabel(appPlatform) : '', result.locale ?? '']
        .filter((p) => p !== '')
        .join(' · ');
      const parts = [
        result.created > 0
          ? where
            ? t('ai:accepted.keywordsAddedTo', { count: result.created, where })
            : t('ai:accepted.keywordsAdded', { count: result.created })
          : where
            ? t('ai:accepted.nothingNewFor', { where })
            : t('ai:accepted.nothingNew'),
      ];
      if (result.existing > 0)
        parts.push(t('ai:accepted.alreadyTracked', { count: result.existing }));
      if (result.rejected > 0)
        parts.push(t('ai:accepted.couldNotTrack', { count: result.rejected }));
      const sentence = t('ai:accepted.sentence', { parts: unitList(parts) });
      const text =
        result.remaining !== undefined && result.remaining > 0
          ? t('ai:accepted.sentenceWithRemaining', {
              sentence,
              remaining: t('ai:accepted.stillProposed', { count: result.remaining }),
            })
          : sentence;
      return {
        text,
        href: asoViewHref(appId, 'keywords', appPlatform ?? platform),
        linkLabel: t('ai:accepted.showThem'),
      };
    }
    case 'listing_text': {
      const names = unitList(result.stagedFields.map(listingFieldLabel));
      const count = result.stagedFields.length;
      return {
        text: names
          ? t('ai:accepted.stagedNamed', { count, locale: result.locale, names })
          : t('ai:accepted.staged', { count, locale: result.locale }),
        href: appAddress(appId, 'pending', platform),
        linkLabel: t('ai:accepted.openPending'),
      };
    }
    case 'reply_draft':
      return {
        text: t('ai:accepted.replySaved'),
        href: appReviewsHref(appId, platform),
        linkLabel: t('ai:accepted.openReviews'),
      };
    case 'insight':
      return { text: t('ai:accepted.reviewed'), href: null, linkLabel: null };
  }
}

/** A suggestion that was accepted or dismissed stays in the list of the app, but is not open any more. */
export const isOpen = (s: Pick<AiSuggestionView, 'status'>): boolean => s.status === 'proposed';

export function openSuggestions(list: readonly AiSuggestionView[]): AiSuggestionView[] {
  return list.filter(isOpen);
}

/** "3 suggestions" for the line of the tray. */
export const openLine = (n: number, platform?: string): string =>
  platform
    ? t('ai:tray.lineWithPlatform', { count: n, platform })
    : t('ai:tray.line', { count: n });

/** The heading of one suggestion: what it is, for which language. */
export function suggestionTitle(proposal: AiProposal): string {
  switch (proposal.kind) {
    case 'keywords':
      return proposal.country
        ? t('ai:title.keywordsCountry', {
            locale: proposal.locale,
            country: proposal.country.toUpperCase(),
          })
        : t('ai:title.keywords', { locale: proposal.locale });
    case 'listing_text':
      return t('ai:title.listingText', { locale: proposal.locale });
    case 'reply_draft':
      return t('ai:title.replyDraft');
    case 'listing_variants':
      return t('ai:title.variants', { locale: proposal.locale });
    case 'insight':
      return insightTitle(proposal);
  }
}

// ---------------------------------------------------------------------------------------------
// Errors: fixed sentences from fixed codes

const wait = (seconds: number | undefined): string => {
  const s = seconds !== undefined && seconds > 0 ? seconds : 60;
  if (s < 60) return t('ai:wait.seconds', { count: Math.ceil(s) });
  return t('ai:wait.minutes', { count: Math.ceil(s / 60) });
};

// ---------------------------------------------------------------------------------------------
// A refused address of a model server: said plainly, and before the failure when the server's own policy is known

/** The fixed codes the API gives for a refused address (`hint` or `reason` or an issue `code`). */
export type AddressHintCode = 'private_address_blocked' | 'plain_http_not_allowed';
export const ADDRESS_ENV = 'KILN_AI_ALLOW_PRIVATE_URLS';

/** Keys of the sentences (`addressText` translates them). */
export const ADDRESS_TEXTS: Record<AddressHintCode, string> = {
  private_address_blocked: k('ai:address.privateBlocked'),
  plain_http_not_allowed: k('ai:address.plainHttp'),
};
export const addressText = (code: AddressHintCode): string =>
  t(ADDRESS_TEXTS[code], { env: ADDRESS_ENV });

const notFoundText = (): string => t('ai:address.notFound');

export const isAddressHint = (value: unknown): value is AddressHintCode =>
  value === 'private_address_blocked' || value === 'plain_http_not_allowed';

/** The hint code of an API error body (`hint`, or `reason` on an unavailable call), if it is one of the fixed ones. */
export function addressHintOf(error: unknown): AddressHintCode | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { hint?: unknown; reason?: unknown };
  if (isAddressHint(body.hint)) return body.hint;
  if (isAddressHint(body.reason)) return body.reason;
  return null;
}

/** Whether an address looks like this machine or a private network (names and literals; the server decides for real, by resolving it). */
export function looksPrivateAddress(url: string): boolean {
  const m = /^https?:\/\/(\[[^\]]+\]|[^\s/:?#]+)/i.exec(url.trim());
  if (!m) return false;
  const host = (m[1] as string).replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host === 'host.docker.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  )
    return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host))
    return true;
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return !host.includes('.');
  const a = Number(quad[1]);
  const b = Number(quad[2]);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * What to tell a person typing the address of a model server, BEFORE anything fails: this server's own policy is in the configuration
 * (`server.allowPrivateUrls`). Null when nothing needs saying.
 */
export function addressAdvice(
  url: string,
  allowPrivateUrls: boolean,
): { tone: 'warn' | 'info'; text: string } | null {
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const http = /^http:\/\//i.test(text);
  if (!allowPrivateUrls && looksPrivateAddress(text))
    return { tone: 'warn', text: addressText('private_address_blocked') };
  if (http && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text))
    return { tone: 'warn', text: addressText('plain_http_not_allowed') };
  return null;
}

/** A soft hint for an address that has no path: most servers expect it to end in /v1 (nothing is added for the person). */
export const needsV1Hint = (url: string): boolean => /^https?:\/\/[^/\s]+\/?$/i.test(url.trim());

/**
 * One sentence for a failed AI call. The sentence is chosen here from the error code (and the status for `ai_unavailable`):
 * the message of the server and the words of a provider are never shown.
 */
export function aiErrorMessage(error: unknown, fallbackText?: string): string {
  const fallback = fallbackText ?? t('ai:error.generic');
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body as { reason?: unknown; resetsAt?: unknown };
  switch (error.code) {
    case 'network':
      return error.message;
    case 'ai_not_enabled':
      return body.reason === 'server' ? offServerText() : t('ai:state.offWorkspace');
    case 'ai_not_configured': {
      const hint = addressHintOf(error);
      if (hint) return addressText(hint);
      return t('ai:state.notSetUpMember');
    }
    case 'task_not_available':
      return t('ai:error.taskNotAvailable');
    case 'no_listing_text':
      return t('ai:error.noListingText');
    case 'ai_input_too_large':
      return t('ai:error.inputTooLarge');
    case 'ai_auth':
      return t('ai:error.auth');
    case 'ai_too_large':
      return t('ai:error.tooLarge');
    case 'ai_budget_exhausted':
      return typeof body.resetsAt === 'number'
        ? t('ai:error.budgetExhaustedUntil', { date: resetText(body.resetsAt) })
        : t('ai:error.budgetExhausted');
    case 'ai_busy':
    case 'rate_limited':
    case 'ai_rate_limited':
      return t('ai:error.tooManyRequests', { wait: wait(error.retryAfter) });
    case 'ai_invalid_output': {
      const hint = invalidOutputHint(body.reason);
      return hint ? t('ai:error.invalidOutput', { hint }) : t('ai:error.invalidOutputRetry');
    }
    case 'ai_unavailable': {
      const hint = addressHintOf(error);
      if (hint) return addressText(hint);
      if (body.reason === 'http_404') return notFoundText();
      return error.status === 504 || body.reason === 'timeout'
        ? t('ai:error.timeout')
        : t('ai:error.unreachable');
    }
    case 'forbidden':
      return t('ai:error.forbidden');
    case 'not_found':
      return t('ai:error.notFound');
    case 'suggestion_not_proposed':
      return t('ai:error.suggestionNotProposed');
    case 'nothing_acceptable':
      return t('ai:error.nothingAcceptable');
    case 'staged_exists':
      return t('ai:error.stagedExists');
    case 'draft_exists':
      return t('ai:error.draftExists');
    case 'reply_not_editable':
      return t('ai:error.replyNotEditable');
    case 'reply_disabled':
      return t('ai:error.replyDisabled');
    case 'field_not_pushable':
      return t('ai:error.fieldNotPushable');
    case 'too_many_items':
    case 'keyword_limit':
      return t('ai:error.keywordLimit');
    case 'invalid_request':
      return t('ai:error.invalidRequest');
    case 'no_reviews':
      return t('ai:error.noReviews');
    case 'nothing_to_do':
      return t('ai:error.nothingToDo');
    case 'no_data':
      return t('ai:error.noData');
    case 'goal_needed':
      return t('ai:error.goalNeeded');
    case 'ai_cost_cap_reached':
      return typeof body.resetsAt === 'number'
        ? t('ai:error.costCapUntil', { date: resetText(body.resetsAt) })
        : t('ai:error.costCap');
    default:
      return error.status >= 500 ? t('ai:error.server') : fallback;
  }
}

/** A sentence for a failed save of the settings or of the key. The server's validation sentences (fixed, about a setting) are passed on. */
export function aiSaveMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'invalid_setting') {
    const issues = (error.body as { issues?: unknown }).issues;
    const lines = Array.isArray(issues)
      ? issues
          .map((i) => {
            if (!i || typeof i !== 'object') return '';
            // A refused address has a fixed code: the sentence is chosen here, with what to do about it.
            if (isAddressHint((i as { code?: unknown }).code))
              return addressText((i as { code: AddressHintCode }).code);
            return typeof (i as { message?: unknown }).message === 'string'
              ? (i as { message: string }).message
              : '';
          })
          .filter((m) => m !== '')
          .slice(0, 3)
      : [];
    return lines.length > 0 ? lines.join(' ') : t('ai:save.invalidSetting');
  }
  if (error instanceof ApiError && error.code === 'invalid_secret')
    return t('ai:save.invalidSecret');
  return aiErrorMessage(error, t('ai:save.failed'));
}

/** The accept was refused because something different is there already; saying yes sends it again with `replace`. */
export const needsReplace = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 409 &&
  (error.code === 'staged_exists' || error.code === 'draft_exists');

// ---------------------------------------------------------------------------------------------
// The test of the connection

/** Why an answer could not be used, from the fixed `reason` of an invalid output. Empty for an unknown reason. */
export function invalidOutputHint(reason: unknown): string {
  switch (reason) {
    case 'not_json':
      return t('ai:hint.notJson');
    case 'truncated':
      return t('ai:hint.truncated');
    case 'schema':
      return t('ai:hint.schema');
    case 'no_text':
      return t('ai:hint.noText');
    case 'refusal':
      return t('ai:hint.refusal');
    default:
      return '';
  }
}

/** The most characters of the model's answer a screen shows under a failed test. */
export const AI_SAMPLE_CHARS = 300;

/**
 * What the model answered, for the card under a failed connection test: the `sample` of an unusable answer, cut to 300 characters and
 * without control characters. Empty when there is none. It is text the model wrote: show it as plain text only, never as markup.
 */
export function aiTestSample(outcome: AiTestOutcome): string {
  if (outcome.ok || outcome.kind !== 'invalid_output' || typeof outcome.sample !== 'string')
    return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
  const clean = outcome.sample
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, AI_SAMPLE_CHARS).join('');
}

const TEST_FAILURES: Record<string, string> = {
  not_configured: k('ai:test.notConfigured'),
  auth: k('ai:test.auth'),
  rate_limited: k('ai:test.rateLimited'),
  too_large: k('ai:test.tooLarge'),
  invalid_output: k('ai:test.invalidOutputPlain'),
};

/** The sentence for a finished test, chosen from fixed codes (never the provider's own text). */
export function aiTestText(
  outcome: AiTestOutcome,
  providers: readonly Pick<AiProviderView, 'id' | 'label'>[] = [],
): { ok: boolean; text: string } {
  if (outcome.ok) {
    const label = providers.find((p) => p.id === outcome.provider)?.label;
    return {
      ok: true,
      text: label
        ? t('ai:test.connected', { provider: label, model: outcome.model })
        : t('ai:test.connectedGeneric', { model: outcome.model }),
    };
  }
  if (outcome.kind === 'unavailable') {
    if (outcome.reason === 'timeout') return { ok: false, text: t('ai:test.timeout') };
    if (isAddressHint(outcome.reason)) return { ok: false, text: addressText(outcome.reason) };
    if (outcome.reason === 'address_not_allowed')
      return { ok: false, text: t('ai:test.addressNotAllowed') };
    if (outcome.reason === 'http_404') return { ok: false, text: notFoundText() };
    return { ok: false, text: t('ai:test.unreachable') };
  }
  if (outcome.kind === 'invalid_output') {
    const hint = invalidOutputHint(outcome.reason);
    if (hint) return { ok: false, text: t('ai:test.invalidOutput', { hint }) };
  }
  const failure = TEST_FAILURES[outcome.kind ?? ''];
  return { ok: false, text: failure ? t(failure) : t('ai:test.generic') };
}

// ---------------------------------------------------------------------------------------------
// The settings form

export type AiForm = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  /** A number as text while typing. */
  budget: string;
  /** Write-only: what is typed now, never what is stored. Empty keeps the saved key. */
  apiKey: string;
  /** Share of a monthly limit (whole percent, as text) from which a run shows a warning. 0 means never. */
  softWarn: string;
  /** Dollars per million tokens, as text ("3", "0.25"). Empty or 0: not set, so no cost is estimated. */
  priceIn: string;
  priceOut: string;
  /** Dollars per month, as text. Empty or 0: no cost cap. */
  costCap: string;
};

export type AiFormErrors = Partial<
  Record<
    'model' | 'baseUrl' | 'budget' | 'apiKey' | 'softWarn' | 'priceIn' | 'priceOut' | 'costCap',
    string
  >
>;

/** The soft warning starts at this share unless an admin chose another (the server's default). */
export const DEFAULT_SOFT_WARN = 80;

export function formFromConfig(config: Pick<AiConfig, 'settings'>): AiForm {
  const s = config.settings;
  return {
    enabled: s.enabled,
    provider: s.provider,
    model: s.model,
    baseUrl: s.baseUrl ?? '',
    budget: String(s.monthlyTokenBudget),
    apiKey: '',
    softWarn: String(s.softWarnPercent ?? DEFAULT_SOFT_WARN),
    priceIn: centsInput(s.priceInputCentsPerMTok ?? 0),
    priceOut: centsInput(s.priceOutputCentsPerMTok ?? 0),
    costCap: centsInput(s.monthlyCostCapCents ?? 0),
  };
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export function validateAiForm(
  form: AiForm,
  config: Pick<AiConfig, 'providers' | 'limits'>,
): AiFormErrors {
  const errors: AiFormErrors = {};
  const model = form.model.trim();
  if (model !== '' && (model.length > 100 || !MODEL.test(model))) errors.model = t('ai:form.model');
  const url = form.baseUrl.trim();
  if (url !== '' && !/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(url))
    errors.baseUrl = t('ai:form.baseUrl');
  const budget = form.budget.trim();
  const max = config.limits.maxMonthlyTokenBudget ?? 1_000_000_000;
  if (!/^\d{1,12}$/.test(budget) || Number(budget) > max)
    errors.budget = t('ai:form.budget', { max: countText(max) });
  const soft = form.softWarn.trim();
  if (!/^\d{1,3}$/.test(soft) || Number(soft) > 100) errors.softWarn = t('ai:form.softWarn');
  const money = (text: string): number | null => centsFromText(text);
  const priceIn = money(form.priceIn);
  if (priceIn === null || priceIn > 1_000_000) errors.priceIn = t('ai:form.priceIn');
  const priceOut = money(form.priceOut);
  if (priceOut === null || priceOut > 1_000_000) errors.priceOut = t('ai:form.priceOut');
  const cap = money(form.costCap);
  if (cap === null || cap > 100_000_000) errors.costCap = t('ai:form.costCap');
  if (form.apiKey.trim() !== '') {
    const provider = config.providers.find((p) => p.id === form.provider);
    if (provider) {
      const problem = checkSecret(
        provider.credentialKind,
        buildSecret(provider.credentialKind, { apiKey: form.apiKey }),
      );
      if (problem) errors.apiKey = problem;
    }
  }
  return errors;
}

/** The settings that differ from the saved ones, as the body of PUT /ai/config. The key is not a setting. */
export function aiChanges(config: Pick<AiConfig, 'settings'>, form: AiForm): AiSettingsChanges {
  const s = config.settings;
  const changes: AiSettingsChanges = {};
  if (form.enabled !== s.enabled) changes.enabled = form.enabled;
  if (form.provider !== s.provider) changes.provider = form.provider;
  const model = form.model.trim();
  if (model !== s.model) changes.model = model === '' ? null : model;
  const url = form.baseUrl.trim();
  if (url !== (s.baseUrl ?? '')) changes.baseUrl = url === '' ? null : url;
  const budget = Number(form.budget.trim());
  if (Number.isFinite(budget) && form.budget.trim() !== '' && budget !== s.monthlyTokenBudget)
    changes.monthlyTokenBudget = budget;
  const soft = form.softWarn.trim();
  if (/^\d{1,3}$/.test(soft) && Number(soft) !== (s.softWarnPercent ?? DEFAULT_SOFT_WARN))
    changes.softWarnPercent = Number(soft);
  const priceIn = centsFromText(form.priceIn);
  if (priceIn !== null && priceIn !== (s.priceInputCentsPerMTok ?? 0))
    changes.priceInputCentsPerMTok = priceIn;
  const priceOut = centsFromText(form.priceOut);
  if (priceOut !== null && priceOut !== (s.priceOutputCentsPerMTok ?? 0))
    changes.priceOutputCentsPerMTok = priceOut;
  const cap = centsFromText(form.costCap);
  if (cap !== null && cap !== (s.monthlyCostCapCents ?? 0)) changes.monthlyCostCapCents = cap;
  return changes;
}

export const keyTyped = (form: Pick<AiForm, 'apiKey'>): boolean => form.apiKey.trim() !== '';

/** Anything to save: a changed setting or a new key. */
export const isAiDirty = (config: Pick<AiConfig, 'settings'>, form: AiForm): boolean =>
  Object.keys(aiChanges(config, form)).length > 0 || keyTyped(form);

/** The vault credential that holds the key of a provider: the oldest of its kind, which is the one the server uses. */
export function oldestCredentialOfKind<T extends { id: string; kind: string; createdAt: number }>(
  list: readonly T[],
  kind: string,
): T | undefined {
  let found: T | undefined;
  for (const c of list)
    if (c.kind === kind && (found === undefined || c.createdAt < found.createdAt)) found = c;
  return found;
}

// ---------------------------------------------------------------------------------------------
// Model discovery (POST /ai/models)

/** What the request needs from the form and the saved configuration. Never stored: the key is only sent. */
export function modelsBody(
  form: Pick<AiForm, 'provider' | 'baseUrl' | 'apiKey'>,
  config: Pick<AiConfig, 'providers'>,
): AiModelsBody {
  const provider = config.providers.find((p) => p.id === form.provider);
  const body: AiModelsBody = { provider: form.provider };
  const url = form.baseUrl.trim();
  if (provider?.needsUrl && url !== '') body.baseUrl = url;
  const key = form.apiKey.trim();
  if (key !== '') body.apiKey = key;
  return body;
}

/**
 * Whether the list may be loaded WITHOUT the person asking (when the card opens and the form settles): the provider and the parts it needs are
 * there and valid, and the address is not one this server is known to refuse. A hosted provider needs a key (typed or saved); a compatible
 * server needs its address. The button always works; this only decides the automatic call.
 */
export function canAutoLoadModels(
  form: AiForm,
  config: Pick<AiConfig, 'providers' | 'limits' | 'server'>,
): boolean {
  const provider = config.providers.find((p) => p.id === form.provider);
  if (!provider) return false;
  const errors = validateAiForm(form, config);
  if (errors.apiKey || errors.baseUrl) return false;
  if (provider.needsUrl) {
    const url = form.baseUrl.trim();
    if (url === '') return false;
    return addressAdvice(url, config.server.allowPrivateUrls) === null;
  }
  return form.apiKey.trim() !== '' || provider.credentialPresent;
}

/** A short signature of what the list depends on, to load once per change and never twice for the same thing. The key is reduced to its length. */
export const modelsSignature = (form: Pick<AiForm, 'provider' | 'baseUrl' | 'apiKey'>): string =>
  `${form.provider}|${form.baseUrl.trim()}|${form.apiKey.trim().length}`;

/** The options of the combobox: the list, and the chosen model first when it is not in the list (it is never dropped). */
export function modelOptions(models: readonly AiModel[], chosen: string): AiModel[] {
  const current = chosen.trim();
  if (current === '' || models.some((m) => m.id === current)) return models.slice();
  return [{ id: current, label: t('ai:models.current') }, ...models];
}

/** The quiet line under the field about where the list came from, or null when it came from the provider (or nothing was loaded). */
export function modelsNote(
  result: Pick<AiModelsResponse, 'source' | 'reason' | 'models'> | null,
  provider: AiProviderView | null,
): string | null {
  if (!result) return null;
  if (result.source === 'provider')
    return result.models.length === 0 ? t('ai:models.noneListed') : null;
  if (result.reason === 'no_credential') return t('ai:models.noKey');
  if (result.models.length === 0)
    return provider
      ? t('ai:models.readFailedFrom', { provider: provider.label })
      : t('ai:models.readFailed');
  return provider
    ? t('ai:models.fallbackFrom', { provider: provider.label })
    : t('ai:models.fallback');
}

/** The model is typed, a list was read from the provider, and the name is not in it: said quietly, the name is kept. */
export const modelNotListed = (
  result: Pick<AiModelsResponse, 'source' | 'models'> | null,
  chosen: string,
): boolean => {
  const current = chosen.trim();
  return (
    result !== null &&
    result.source === 'provider' &&
    result.models.length > 0 &&
    current !== '' &&
    !result.models.some((m) => m.id === current)
  );
};

/** The count line after a successful read from the provider. */
export const modelsCountText = (n: number): string => t('ai:models.count', { count: n });

/** Whether an address of an OpenAI compatible server is on this machine or a private network (nothing is billed there). */
export function isLocalAddress(address: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(address.trim());
  if (!m) return false;
  const host = (m[1] as string).toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === 'host.docker.internal') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ip) return false;
  const a = Number(ip[1]);
  const b = Number(ip[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
