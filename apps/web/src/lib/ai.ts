import {
  type AiAcceptedRef,
  type AiFlag,
  type AiProposal,
  type AiProposalKind,
  type AiProvider,
  type AiSuggestionView,
  type Platform,
  type Role,
  aiAcceptAction,
  buildSecret,
  can,
  checkSecret,
  isApplePlatform,
} from '@mrm/core';
import { ApiError } from './api.ts';
import { type PlatformScope, appAddress, appReviewsHref } from './app-scope.ts';
import { asoViewHref } from './aso.ts';

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
export type AiReason = 'no_model' | 'no_credential' | 'no_url' | 'credential_unreadable' | 'bad_url';

export type AiProviderView = {
  id: AiProvider;
  label: string;
  credentialKind: 'ai_anthropic' | 'ai_openai' | 'ai_openai_compatible';
  credentialRequired: boolean;
  needsUrl: boolean;
  privacy: string;
  credentialPresent: boolean;
};

export type AiUsage = { month: string; used: number; budget: number; remaining: number | null; runs: number; resetsAt: number };

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
  };
  defaults: { monthlyTokenBudget: number; maxOutputTokens: number; maxInputTokens: number };
  /** The settings an operator fixed in the server's environment. */
  overridden: string[];
  providers: AiProviderView[];
  usage: AiUsage;
  limits: Record<string, number>;
  canManage: boolean;
};

export type AiScopeField = { name: string; required: boolean; description: string; values?: string[] };
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
};

export type AiAcceptBody = { items?: number[]; fields?: string[]; replace?: boolean };
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
  | { ok: false; provider?: AiProvider; kind?: string; message?: string; reason?: string };

// ---------------------------------------------------------------------------------------------
// Where the feature stands, in words

export const AI_ENV = 'MRM_AI_ENABLED';

const OFF_SERVER_TEXT = `AI assistance is switched off on this server. Whoever runs the server turns it on with ${AI_ENV}=true and restarts it.`;

export type StateInfo = { tone: 'ok' | 'info' | 'warn'; label: string; message: string };

const NOT_CONFIGURED_ADMIN: Record<AiReason, string> = {
  no_model: 'Choose a model to finish the set-up. The model name comes from your provider; there is no default.',
  no_credential: 'Add the API key of the provider to finish the set-up.',
  no_url: 'Enter the address of the model server to finish the set-up.',
  credential_unreadable: 'The saved key could not be read. Enter it again.',
  bad_url: 'This server does not allow that address. Change it, or ask whoever runs this server.',
};

/** The one sentence that says where AI assistance stands. `canManage` decides whether it says what to do or who can. */
export function aiStateInfo(config: Pick<AiConfig, 'state' | 'reason' | 'canManage' | 'settings'> & { providers?: AiProviderView[] }): StateInfo {
  switch (config.state) {
    case 'off_server':
      return {
        tone: 'info',
        label: 'Off on this server',
        message: OFF_SERVER_TEXT,
      };
    case 'off_workspace':
      return {
        tone: 'info',
        label: 'Off',
        message: config.canManage ? 'AI assistance is off for this workspace. Turn it on below.' : 'AI assistance is off for this workspace. An admin can turn it on in Settings.',
      };
    case 'not_configured': {
      const reason = config.reason ?? 'no_model';
      return {
        tone: 'warn',
        label: 'Not set up',
        message: config.canManage ? NOT_CONFIGURED_ADMIN[reason] : 'AI assistance is not set up yet. An admin can finish it in Settings.',
      };
    }
    default: {
      const label = config.providers?.find((p) => p.id === config.settings.provider)?.label;
      return { tone: 'ok', label: 'Ready', message: label ? `Ready. Using ${label}.` : 'Ready.' };
    }
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1 December": the day the monthly limit starts again (UTC). */
export function resetText(resetsAt: number): string {
  const d = new Date(resetsAt);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] as string}`;
}

export const countText = (n: number): string => n.toLocaleString('en');

/** "120,000 of 500,000 used this month. Starts again on 1 December." */
export function usageText(usage: Pick<AiUsage, 'used' | 'budget' | 'resetsAt'>): string {
  if (usage.budget <= 0) return `${countText(usage.used)} used this month. No limit is set here; your provider may still have one.`;
  return `${countText(usage.used)} of ${countText(usage.budget)} used this month. Starts again on ${resetText(usage.resetsAt)}.`;
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
  if (provider === null) return 'Text you choose is sent to the AI provider you set up.';
  if (provider.id === 'openai_compatible') return 'Text you choose is sent to the model server whose address you enter.';
  return `Text you choose is sent to ${provider.label}.`;
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
export function suggestAvailability(input: { role: Role; config: AiConfig | null; kind: AiProposalKind }): SuggestAvailability {
  const { role, config, kind } = input;
  if (!can(role, 'ai.use') || !can(role, aiAcceptAction[kind])) return HIDDEN;
  if (config === null) return HIDDEN;
  if (config.state === 'off_server' || config.state === 'off_workspace') return HIDDEN;
  if (config.state === 'not_configured') return { visible: true, enabled: false, reason: aiStateInfo(config).message };
  if (budgetUsedUp(config.usage)) {
    return { visible: true, enabled: false, reason: `The monthly limit is used up. It starts again on ${resetText(config.usage.resetsAt)}.` };
  }
  return { visible: true, enabled: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// The disclosure before a first run

/** What a storage needs for the "don't ask again" choice (a `Storage`, or a stand-in in tests). */
export type DisclosureStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const DISCLOSURE_PREFIX = 'mrm.ai.skip.';
export const disclosureKey = (taskId: string): string => `${DISCLOSURE_PREFIX}${taskId}`;

/**
 * What a "don't ask again" is valid for: this version of the task (its disclosure may have changed) and this provider (who receives
 * the data may have changed). A different stamp asks again.
 */
export const disclosureStamp = (task: { version: number }, providerId: string | null): string => `${task.version}:${providerId ?? ''}`;

export type DisclosureGate = {
  /** True when the person must see what is sent before this run. */
  needs(task: { id: string; version: number }, providerId: string | null): boolean;
  /** The person saw it and went on. `remember` is "Don't ask again for this task". */
  confirm(task: { id: string; version: number }, providerId: string | null, remember: boolean): void;
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

export const flagTexts: Record<AiFlag, { text: string; tone: FlagTone; blocks: string | null }> = {
  already_tracked: { text: 'Already tracked', tone: 'info', blocks: 'It is already tracked.' },
  duplicate: { text: 'Repeated', tone: 'info', blocks: 'It repeats another idea.' },
  invalid_term: { text: 'Not a usable keyword', tone: 'bad', blocks: 'It is not a usable keyword.' },
  field_not_for_store: { text: 'Field not in this store', tone: 'info', blocks: null },
  over_limit: { text: 'Over the limit', tone: 'bad', blocks: 'It is longer than the store allows. Shorten it by hand.' },
  trimmed: { text: 'Trimmed to fit', tone: 'warn', blocks: null },
  unchanged: { text: 'Same as now', tone: 'info', blocks: 'It is the same as the current text.' },
  not_stageable: { text: 'Cannot be staged', tone: 'bad', blocks: 'A draft push cannot write this field.' },
  empty: { text: 'Empty', tone: 'bad', blocks: 'It is empty.' },
  cleaned: { text: 'Odd characters removed', tone: 'warn', blocks: null },
  markup: { text: 'Looks like HTML', tone: 'bad', blocks: 'Replies are plain text, and this looks like HTML.' },
};

export const flagInfos = (flags: readonly AiFlag[]): FlagInfo[] =>
  flags.map((flag) => ({ flag, text: flagTexts[flag]?.text ?? flag, tone: flagTexts[flag]?.tone ?? 'info' }));

/** Why an item cannot be accepted, from its flags. */
export function blockedReason(flags: readonly AiFlag[]): string {
  for (const flag of flags) {
    const blocks = flagTexts[flag]?.blocks;
    if (blocks) return `Cannot be accepted. ${blocks}`;
  }
  return 'Cannot be accepted.';
}

const LISTING_LABELS: Record<string, string> = {
  description: 'Description',
  keywords: 'Keyword field',
  promotional_text: 'Promotional text',
  title: 'Title',
  short_description: 'Short description',
  full_description: 'Full description',
};
export const listingFieldLabel = (field: string): string => LISTING_LABELS[field] ?? field;

/** The fields the "listing_improve" task offers (the ones a draft push can write), per platform. */
const IMPROVABLE: Record<'apple' | 'play', readonly string[]> = {
  apple: ['description', 'keywords', 'promotional_text'],
  play: ['title', 'short_description', 'full_description'],
};
export const canImproveField = (platform: Platform, field: string): boolean =>
  IMPROVABLE[isApplePlatform(platform) ? 'apple' : 'play'].indexOf(field) !== -1;

export type RowMeter = { used: number; limit: number; remaining: number; over: boolean; unit: 'characters' | 'bytes'; percent: number };

/** The numbers of a char-limit meter for a text of `used` against `limit` (the shape the keyword budget meter draws). */
export function meterFor(used: number, limit: number, unit: 'characters' | 'bytes'): RowMeter {
  const remaining = limit - used;
  return { used, limit, remaining, over: remaining < 0, unit, percent: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0 };
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
        note: item.field ? `For the ${listingFieldLabel(item.field).toLowerCase()}` : null,
        flags: flagInfos(item.flags),
        acceptable: item.acceptable,
        blocked: item.acceptable ? null : blockedReason(item.flags),
        meter: null,
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
      }));
    case 'reply_draft':
      return [
        {
          index: 0,
          key: 'reply',
          title: 'Reply',
          text: proposal.text,
          reason: '',
          note: null,
          flags: flagInfos(proposal.flags),
          acceptable: proposal.acceptable,
          blocked: proposal.acceptable ? null : blockedReason(proposal.flags),
          meter: meterFor(proposal.length, proposal.limit, 'characters'),
        },
      ];
  }
}

export const acceptableIndexes = (rows: readonly ProposalRow[]): number[] => rows.filter((r) => r.acceptable).map((r) => r.index);

/** Everything that can be accepted is selected to start with; the rest is never selected. */
export const initialSelection = (rows: readonly ProposalRow[]): number[] => acceptableIndexes(rows);

/** Switches one row of a selection. A row that cannot be accepted is never added. */
export function toggleSelection(rows: readonly ProposalRow[], selected: readonly number[], index: number, on: boolean): number[] {
  const ok = acceptableIndexes(rows);
  const next = selected.filter((i) => i !== index && ok.indexOf(i) !== -1);
  if (on && ok.indexOf(index) !== -1) next.push(index);
  return next.sort((a, b) => a - b);
}

/**
 * The body of the accept call for the chosen rows. It names exactly what the person ticked (never "everything"), so what is
 * accepted is what was on the screen. The server closes the suggestion on the first accept: rows not chosen are not kept for later.
 */
export function acceptBody(proposal: AiProposal, rows: readonly ProposalRow[], selected: readonly number[], replace = false): AiAcceptBody {
  const chosen = rows.filter((r) => r.acceptable && selected.indexOf(r.index) !== -1);
  const body: AiAcceptBody = {};
  if (proposal.kind === 'keywords') body.items = chosen.map((r) => r.index);
  else if (proposal.kind === 'listing_text') body.fields = chosen.map((r) => r.key);
  if (replace) body.replace = true;
  return body;
}

/** The label of the accept button: it says what accepting does ("Track 2 keywords"), not just "Accept". */
export function acceptLabel(kind: AiProposalKind, chosen: number): string {
  switch (kind) {
    case 'keywords':
      return `Track ${plural(chosen, 'keyword', 'keywords')}`;
    case 'listing_text':
      return `Stage ${plural(chosen, 'text', 'texts')}`;
    case 'reply_draft':
      return 'Save as reply draft';
  }
}

// ---------------------------------------------------------------------------------------------
// What accepting did, and where to look

export type AcceptedNote = { text: string; href: string | null; linkLabel: string | null };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The sentence after an accept and the link to where the result lives (ids only came back, never text). */
export function acceptedNote(result: AiAcceptedRef, appId: string, platform: PlatformScope | null = null): AcceptedNote {
  switch (result.kind) {
    case 'keywords': {
      const parts = [`${plural(result.created, 'keyword', 'keywords')} added to the tracked keywords`];
      if (result.existing > 0) parts.push(`${result.existing} already tracked`);
      return { text: `${parts.join(', ')}.`, href: asoViewHref(appId, 'keywords', platform), linkLabel: 'Open the keywords list' };
    }
    case 'listing_text': {
      const names = result.stagedFields.map(listingFieldLabel).join(', ');
      return {
        text: `Staged ${plural(result.stagedFields.length, 'text', 'texts')} for ${result.locale}${names ? ` (${names})` : ''}. Nothing is sent to a store until you push it from Pending changes.`,
        href: appAddress(appId, 'pending', platform),
        linkLabel: 'Open Pending changes',
      };
    }
    case 'reply_draft':
      return { text: 'Saved as a reply draft. Nothing is sent.', href: appReviewsHref(appId, platform), linkLabel: 'Open the reviews' };
  }
}

/** A suggestion that was accepted or dismissed stays in the list of the app, but is not open any more. */
export const isOpen = (s: Pick<AiSuggestionView, 'status'>): boolean => s.status === 'proposed';

export function openSuggestions(list: readonly AiSuggestionView[]): AiSuggestionView[] {
  return list.filter(isOpen);
}

/** "3 suggestions" for the line of the tray. */
export const openLine = (n: number): string => `AI suggestions (${n})`;

/** The heading of one suggestion: what it is, for which language. */
export function suggestionTitle(proposal: AiProposal): string {
  switch (proposal.kind) {
    case 'keywords':
      return `Keyword ideas · ${proposal.locale}${proposal.country ? ` · ${proposal.country.toUpperCase()}` : ''}`;
    case 'listing_text':
      return `Listing text · ${proposal.locale}`;
    case 'reply_draft':
      return 'Reply draft';
  }
}

// ---------------------------------------------------------------------------------------------
// Errors: fixed sentences from fixed codes

const wait = (seconds: number | undefined): string => {
  const s = seconds !== undefined && seconds > 0 ? seconds : 60;
  if (s < 60) return `${Math.ceil(s)} seconds`;
  const m = Math.ceil(s / 60);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};

// ---------------------------------------------------------------------------------------------
// A refused address of a model server: said plainly, and before the failure when the server's own policy is known

/** The fixed codes the API gives for a refused address (`hint` or `reason` or an issue `code`). */
export type AddressHintCode = 'private_address_blocked' | 'plain_http_not_allowed';
export const ADDRESS_ENV = 'MRM_AI_ALLOW_PRIVATE_URLS';

export const ADDRESS_TEXTS: Record<AddressHintCode, string> = {
  private_address_blocked: `This server only talks to public addresses. To use a model on your own machine or network, the person who runs this server sets ${ADDRESS_ENV}=true and restarts it. In Docker, localhost is the container itself, and plain http is accepted only for localhost, so a model on the host machine needs an https address this server can reach (or the server run outside Docker).`,
  plain_http_not_allowed: `Plain http is accepted only for localhost, and only when the person who runs this server has set ${ADDRESS_ENV}=true. For any other address use https.`,
};

const NOT_FOUND_TEXT = 'The provider answered "not found". Check the model name and, for your own server, the address (it usually ends in /v1).';

export const isAddressHint = (value: unknown): value is AddressHintCode => value === 'private_address_blocked' || value === 'plain_http_not_allowed';

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
  if (host === 'localhost' || host === 'host.docker.internal' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return !host.includes('.');
  const a = Number(quad[1]);
  const b = Number(quad[2]);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * What to tell a person typing the address of a model server, BEFORE anything fails: this server's own policy is in the configuration
 * (`server.allowPrivateUrls`). Null when nothing needs saying.
 */
export function addressAdvice(url: string, allowPrivateUrls: boolean): { tone: 'warn' | 'info'; text: string } | null {
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const http = /^http:\/\//i.test(text);
  if (!allowPrivateUrls && looksPrivateAddress(text)) return { tone: 'warn', text: ADDRESS_TEXTS.private_address_blocked };
  if (http && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)) return { tone: 'warn', text: ADDRESS_TEXTS.plain_http_not_allowed };
  return null;
}

/** A soft hint for an address that has no path: most servers expect it to end in /v1 (nothing is added for the person). */
export const needsV1Hint = (url: string): boolean => /^https?:\/\/[^/\s]+\/?$/i.test(url.trim());

/**
 * One sentence for a failed AI call. The sentence is chosen here from the error code (and the status for `ai_unavailable`):
 * the message of the server and the words of a provider are never shown.
 */
export function aiErrorMessage(error: unknown, fallback = 'That did not work. Try again.'): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body as { reason?: unknown; resetsAt?: unknown };
  switch (error.code) {
    case 'network':
      return error.message;
    case 'ai_not_enabled':
      return body.reason === 'server' ? OFF_SERVER_TEXT : 'AI assistance is off for this workspace. An admin can turn it on in Settings.';
    case 'ai_not_configured': {
      const hint = addressHintOf(error);
      if (hint) return ADDRESS_TEXTS[hint];
      return 'AI assistance is not set up yet. An admin can finish it in Settings.';
    }
    case 'task_not_available':
      return 'This is not available yet.';
    case 'no_listing_text':
      return 'No listing text is stored for this language yet. Sync the app or read the repository first.';
    case 'ai_input_too_large':
      return 'There is too much text to send in one go. Nothing was sent.';
    case 'ai_auth':
      return 'The AI provider did not accept the key. An admin can check it in Settings.';
    case 'ai_too_large':
      return 'The AI provider says the request is too large. Nothing was saved.';
    case 'ai_budget_exhausted':
      return typeof body.resetsAt === 'number'
        ? `The monthly limit is used up. It starts again on ${resetText(body.resetsAt)}. Nothing was sent.`
        : 'The monthly limit is used up. Nothing was sent.';
    case 'ai_busy':
    case 'rate_limited':
    case 'ai_rate_limited':
      return `Too many requests at the moment. Try again in ${wait(error.retryAfter)}.`;
    case 'ai_invalid_output':
      return 'The answer could not be used, so nothing was saved. Try again.';
    case 'ai_unavailable': {
      const hint = addressHintOf(error);
      if (hint) return ADDRESS_TEXTS[hint];
      if (body.reason === 'http_404') return NOT_FOUND_TEXT;
      return error.status === 504 || body.reason === 'timeout' ? 'The AI provider did not answer in time. Try again.' : 'The AI provider could not be reached. Try again later.';
    }
    case 'forbidden':
      return 'Your role does not allow that.';
    case 'not_found':
      return 'That no longer exists.';
    case 'suggestion_not_proposed':
      return 'This suggestion was already accepted or dismissed.';
    case 'nothing_acceptable':
      return 'Nothing you chose can be accepted.';
    case 'staged_exists':
      return 'A different text is already staged for this field.';
    case 'draft_exists':
      return 'A different reply draft already exists.';
    case 'reply_not_editable':
      return 'That reply was sent or is being sent, so it cannot be changed.';
    case 'reply_disabled':
      return 'Replying is switched off on this server.';
    case 'field_not_pushable':
      return 'That field cannot be written by a draft push.';
    case 'too_many_items':
    case 'keyword_limit':
      return 'The app already tracks the most keywords it may.';
    case 'invalid_request':
      return 'Those options cannot be used. Check them and try again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : fallback;
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
            if (isAddressHint((i as { code?: unknown }).code)) return ADDRESS_TEXTS[(i as { code: AddressHintCode }).code];
            return typeof (i as { message?: unknown }).message === 'string' ? (i as { message: string }).message : '';
          })
          .filter((m) => m !== '')
          .slice(0, 3)
      : [];
    return lines.length > 0 ? lines.join(' ') : 'A setting is not valid. Check the form and try again.';
  }
  if (error instanceof ApiError && error.code === 'invalid_secret') return 'That key cannot be used. Check it and try again.';
  return aiErrorMessage(error, 'The settings could not be saved. Try again.');
}

/** The accept was refused because something different is there already; saying yes sends it again with `replace`. */
export const needsReplace = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && (error.code === 'staged_exists' || error.code === 'draft_exists');

// ---------------------------------------------------------------------------------------------
// The test of the connection

const TEST_FAILURES: Record<string, string> = {
  not_configured: 'Not set up yet. Check the model and the key.',
  auth: 'The provider did not accept the key.',
  rate_limited: 'The provider is limiting requests. Try again in a moment.',
  too_large: 'The provider refused the small test request as too large.',
  invalid_output: 'The provider answered, but not in the form this tool needs. Check that the model can return structured answers.',
};

/** The sentence for a finished test, chosen from fixed codes (never the provider's own text). */
export function aiTestText(outcome: AiTestOutcome, providers: readonly Pick<AiProviderView, 'id' | 'label'>[] = []): { ok: boolean; text: string } {
  if (outcome.ok) {
    const label = providers.find((p) => p.id === outcome.provider)?.label ?? 'the provider';
    return { ok: true, text: `Connected to ${label}. The model ${outcome.model} answered.` };
  }
  if (outcome.kind === 'unavailable') {
    if (outcome.reason === 'timeout') return { ok: false, text: 'The provider did not answer in time.' };
    if (isAddressHint(outcome.reason)) return { ok: false, text: ADDRESS_TEXTS[outcome.reason] };
    if (outcome.reason === 'address_not_allowed') return { ok: false, text: 'This server does not allow that address.' };
    if (outcome.reason === 'http_404') return { ok: false, text: NOT_FOUND_TEXT };
    return { ok: false, text: 'The provider could not be reached.' };
  }
  return { ok: false, text: TEST_FAILURES[outcome.kind ?? ''] ?? 'The test did not work. Check the settings and try again.' };
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
};

export type AiFormErrors = Partial<Record<'model' | 'baseUrl' | 'budget' | 'apiKey', string>>;

export function formFromConfig(config: Pick<AiConfig, 'settings'>): AiForm {
  const s = config.settings;
  return {
    enabled: s.enabled,
    provider: s.provider,
    model: s.model,
    baseUrl: s.baseUrl ?? '',
    budget: String(s.monthlyTokenBudget),
    apiKey: '',
  };
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export function validateAiForm(form: AiForm, config: Pick<AiConfig, 'providers' | 'limits'>): AiFormErrors {
  const errors: AiFormErrors = {};
  const model = form.model.trim();
  if (model !== '' && (model.length > 100 || !MODEL.test(model))) errors.model = 'Use the model name exactly as your provider gives it, with no spaces.';
  const url = form.baseUrl.trim();
  if (url !== '' && !/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(url)) errors.baseUrl = 'Start with https:// (or http:// for a model on this machine). No name, password or key in the address.';
  const budget = form.budget.trim();
  const max = config.limits.maxMonthlyTokenBudget ?? 1_000_000_000;
  if (!/^\d{1,12}$/.test(budget) || Number(budget) > max) errors.budget = `Use a whole number from 0 to ${countText(max)}. 0 means no limit here.`;
  if (form.apiKey.trim() !== '') {
    const provider = config.providers.find((p) => p.id === form.provider);
    if (provider) {
      const problem = checkSecret(provider.credentialKind, buildSecret(provider.credentialKind, { apiKey: form.apiKey }));
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
  if (Number.isFinite(budget) && form.budget.trim() !== '' && budget !== s.monthlyTokenBudget) changes.monthlyTokenBudget = budget;
  return changes;
}

export const keyTyped = (form: Pick<AiForm, 'apiKey'>): boolean => form.apiKey.trim() !== '';

/** Anything to save: a changed setting or a new key. */
export const isAiDirty = (config: Pick<AiConfig, 'settings'>, form: AiForm): boolean =>
  Object.keys(aiChanges(config, form)).length > 0 || keyTyped(form);

/** The vault credential that holds the key of a provider: the oldest of its kind, which is the one the server uses. */
export function oldestCredentialOfKind<T extends { id: string; kind: string; createdAt: number }>(list: readonly T[], kind: string): T | undefined {
  let found: T | undefined;
  for (const c of list) if (c.kind === kind && (found === undefined || c.createdAt < found.createdAt)) found = c;
  return found;
}

// ---------------------------------------------------------------------------------------------
// Model discovery (POST /ai/models)

/** What the request needs from the form and the saved configuration. Never stored: the key is only sent. */
export function modelsBody(form: Pick<AiForm, 'provider' | 'baseUrl' | 'apiKey'>, config: Pick<AiConfig, 'providers'>): AiModelsBody {
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
export function canAutoLoadModels(form: AiForm, config: Pick<AiConfig, 'providers' | 'limits' | 'server'>): boolean {
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
  return [{ id: current, label: 'current' }, ...models];
}

/** The quiet line under the field about where the list came from, or null when it came from the provider (or nothing was loaded). */
export function modelsNote(result: Pick<AiModelsResponse, 'source' | 'reason' | 'models'> | null, provider: AiProviderView | null): string | null {
  if (!result) return null;
  if (result.source === 'provider') return result.models.length === 0 ? 'The server answered, but lists no models. Type the model name.' : null;
  if (result.reason === 'no_credential') return 'Add a key to read the list from the provider. These are well known names; you can type any other.';
  if (result.models.length === 0) return `Could not read the list of models${provider ? ` from ${provider.label}` : ''}. Type the model name.`;
  return `Could not read the list from ${provider ? provider.label : 'the provider'}, so these are well known names. You can type any other.`;
}

/** The model is typed, a list was read from the provider, and the name is not in it: said quietly, the name is kept. */
export const modelNotListed = (result: Pick<AiModelsResponse, 'source' | 'models'> | null, chosen: string): boolean => {
  const current = chosen.trim();
  return result !== null && result.source === 'provider' && result.models.length > 0 && current !== '' && !result.models.some((m) => m.id === current);
};

/** The count line after a successful read from the provider. */
export const modelsCountText = (n: number): string => (n === 1 ? '1 model available.' : `${n} models available.`);
