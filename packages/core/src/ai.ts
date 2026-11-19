/**
 * AI assistance: the providers, their credential kinds, the limits, the task ids and the shapes of
 * what a task PROPOSES. Shared by the server (which runs tasks and validates), the connectors (which
 * speak to the providers) and the web UI (which will show disclosures and proposals). Plain functions
 * and types only, no environment APIs, and nothing newer than ES2017, so the web can import it.
 *
 * The rule behind everything here (docs/adr/0016-ai-foundation.md): an AI task returns DATA that is
 * validated against a schema and becomes a PROPOSAL a person looks at. Nothing in this feature can
 * push, submit, publish, release or send a reply.
 */

export const aiProviders = ['anthropic', 'openai', 'openai_compatible'] as const;
export type AiProvider = (typeof aiProviders)[number];

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (aiProviders as readonly string[]).indexOf(value) !== -1;
}

export type AiProviderInfo = {
  label: string;
  /** The vault credential kind that holds this provider's key. */
  credentialKind: 'ai_anthropic' | 'ai_openai' | 'ai_openai_compatible';
  /** False when the provider can run without a key (a local model server). */
  credentialRequired: boolean;
  /** The workspace gives the address of the server (any OpenAI compatible server: Ollama, LM Studio, vLLM). */
  needsUrl: boolean;
  /** Who receives the data of a task. Shown next to the choice: sending it is a privacy decision. */
  privacy: string;
};

export const aiProviderInfo: Record<AiProvider, AiProviderInfo> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    credentialKind: 'ai_anthropic',
    credentialRequired: true,
    needsUrl: false,
    privacy: 'The data listed for a task is sent to Anthropic. Check Anthropic’s terms for your account before you turn this on.',
  },
  openai: {
    label: 'OpenAI',
    credentialKind: 'ai_openai',
    credentialRequired: true,
    needsUrl: false,
    privacy: 'The data listed for a task is sent to OpenAI. Check OpenAI’s terms for your account before you turn this on.',
  },
  openai_compatible: {
    label: 'OpenAI compatible server (Ollama, LM Studio, vLLM, ...)',
    credentialKind: 'ai_openai_compatible',
    credentialRequired: false,
    needsUrl: true,
    privacy:
      'The data listed for a task is sent to the server whose address you enter. On a model you run yourself it stays with you; on a hosted one it goes to that operator.',
  },
};

/** Every task id, including the ones that are registered but not built yet (`status: 'planned'`). */
export const aiTaskIds = [
  'keyword_ideas',
  'listing_improve',
  'review_reply_draft',
  'release_notes',
  'listing_translate',
  'rank_drop_explain',
] as const;
export type AiTaskId = (typeof aiTaskIds)[number];

export function isAiTaskId(value: unknown): value is AiTaskId {
  return typeof value === 'string' && (aiTaskIds as readonly string[]).indexOf(value) !== -1;
}

export const aiSuggestionStatuses = ['proposed', 'accepted', 'dismissed'] as const;
export type AiSuggestionStatus = (typeof aiSuggestionStatuses)[number];

/** What a proposal turns into when a person accepts it. Each kind goes through an EXISTING mechanism. */
export const aiProposalKinds = ['keywords', 'listing_text', 'reply_draft'] as const;
export type AiProposalKind = (typeof aiProposalKinds)[number];

/** The right a person needs to ACCEPT a proposal of each kind (the right of the mechanism it goes through). */
export const aiAcceptAction = {
  keywords: 'aso.write',
  listing_text: 'changesets.write',
  reply_draft: 'reviews.triage',
} as const;

export const aiLimits = {
  /**
   * Default monthly token budget (input and output tokens together) of a workspace. Safe on purpose: a
   * few hundred runs of the built-in tasks at most. 0 means no limit here (the provider may still have one).
   */
  defaultMonthlyTokenBudget: 500_000,
  maxMonthlyTokenBudget: 1_000_000_000,
  /** Most tokens a provider may write for one run. */
  defaultMaxOutputTokens: 4_000,
  minMaxOutputTokens: 100,
  maxMaxOutputTokens: 16_000,
  /** Largest input of one run, in tokens, ESTIMATED (3 characters a token, which over-counts on purpose). */
  defaultMaxInputTokens: 8_000,
  minMaxInputTokens: 500,
  maxMaxInputTokens: 100_000,
  /** Runs at the same time per workspace and process. */
  maxConcurrentPerWorkspace: 2,
  /** Runs per workspace per minute. */
  runsPerMinute: 10,
  /** Longest model name. */
  maxModelChars: 100,
  /** Free text a person may add to a run (a goal, a tone note). */
  maxGoalChars: 300,
  /** Days a suggestion is kept. */
  suggestionRetentionDays: 90,
} as const;

/** A fast over-estimate of the tokens of a text, used for the per-request input cap and the budget reservation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

// ---------------------------------------------------------------------------------------------
// Failures

/** What can go wrong with a provider call. A fixed vocabulary: provider text is never passed on. */
export const aiErrorKinds = ['not_configured', 'auth', 'rate_limited', 'too_large', 'invalid_output', 'unavailable'] as const;
export type AiErrorKind = (typeof aiErrorKinds)[number];

// ---------------------------------------------------------------------------------------------
// Proposals

/**
 * Why an item of a proposal is flagged. Flags are never silent: an item that was changed or cannot be
 * accepted says why. `acceptable: false` items are shown but cannot be accepted.
 */
export const aiFlags = [
  /** Keyword: the app already tracks it in this storefront. */
  'already_tracked',
  /** Keyword: repeated in the same answer. */
  'duplicate',
  /** Keyword: empty, too long or with characters a term cannot have. */
  'invalid_term',
  /** Keyword: the model named a field this store does not have; the field was cleared. */
  'field_not_for_store',
  /** Text: longer than the store allows. The text is kept for reading and cannot be accepted. */
  'over_limit',
  /** Keywords text: entries were dropped from the end so it fits the limit. */
  'trimmed',
  /** Text: the same as what is there now. */
  'unchanged',
  /** Text: the field cannot be written by a draft push (for example the App Store name). */
  'not_stageable',
  /** Text: empty after cleaning. */
  'empty',
  /** Text: control characters were removed. */
  'cleaned',
  /** Reply: looks like HTML. Replies are plain text. */
  'markup',
] as const;
export type AiFlag = (typeof aiFlags)[number];

export type AiKeywordIdea = {
  term: string;
  /** One or two sentences from the model. Untrusted text: show as text, never as markup. */
  reason: string;
  /** The listing field the model suggests the term for, or null (track only). */
  field: string | null;
  acceptable: boolean;
  flags: AiFlag[];
};

export type AiKeywordProposal = {
  kind: 'keywords';
  store: 'app_store' | 'google_play';
  country: string;
  locale: string;
  items: AiKeywordIdea[];
};

export type AiListingField = {
  field: string;
  /** What the model proposes (after trimming of a keywords text, if flagged `trimmed`). */
  text: string;
  reason: string;
  /** In the unit of the field. */
  length: number;
  limit: number | null;
  unit: 'characters' | 'bytes';
  acceptable: boolean;
  flags: AiFlag[];
};

export type AiListingProposal = {
  kind: 'listing_text';
  locale: string;
  fields: AiListingField[];
};

export type AiReplyProposal = {
  kind: 'reply_draft';
  reviewId: string;
  store: 'appstoreconnect' | 'googleplay';
  /** The draft text. It only ever becomes a DRAFT a person edits: nothing here sends it. */
  text: string;
  length: number;
  limit: number;
  acceptable: boolean;
  flags: AiFlag[];
};

export type AiProposal = AiKeywordProposal | AiListingProposal | AiReplyProposal;

/** What accepting created, as ids (never text). */
export type AiAcceptedRef =
  | { kind: 'keywords'; keywordIds: string[]; created: number; existing: number; rejected: number }
  | { kind: 'listing_text'; stagedFields: string[]; locale: string }
  | { kind: 'reply_draft'; reviewId: string; draftId: string };

export type AiSuggestionView = {
  id: string;
  appId: string;
  task: AiTaskId;
  taskVersion: number;
  kind: AiProposalKind;
  status: AiSuggestionStatus;
  provider: AiProvider;
  model: string;
  /** The validated, post-processed output. Review text is not in it; a reply draft is. */
  proposal: AiProposal;
  /** The ids and options of the run (locale, review id, ...), never text. */
  scope: Record<string, unknown>;
  /** SHA-256 of the exact data sent (provenance without keeping it). */
  inputHash: string;
  usage: { inputTokens: number; outputTokens: number };
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  accepted: AiAcceptedRef | null;
};
