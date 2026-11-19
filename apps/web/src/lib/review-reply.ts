import { can, type Role } from '@mrm/core';
import { ApiError } from './api.ts';
import type { Review, ReviewStore } from './reviews.ts';

/**
 * Replying to reviews (docs/api/reviews.md, docs/adr/0007-review-replies.md): types of the API and
 * the pure logic of the reply dialog. A reply is published publicly in the store and this tool
 * cannot recall it, so everything here is about being sure: the exact text, the store, the app and
 * the review are shown, and the server only sends a draft whose hash the person confirmed.
 *
 * The server is the authority on every rule here (text checks, limits, rights). The checks in this
 * file only explain things before a request; they never decide. Written for the ES2017 web build.
 */

export const REPLY_ENV = 'MRM_REVIEW_REPLY_ENABLED';

/** The sentence the confirmation must show, word for word. */
export const PUBLIC_WARNING =
  'This will be published publicly in the store and cannot be recalled by this tool.';

export type ReplyStatus = 'draft' | 'sending' | 'sent' | 'failed' | 'unknown';

export type ReplyDraft = {
  id: string;
  reviewId: string;
  appId: string;
  store: ReviewStore;
  text: string;
  /** SHA-256 hex of the text: sent back as `confirmHash`. */
  textHash: string;
  length: number;
  limit: number;
  status: ReplyStatus;
  errorCode: string | null;
  evidence: Record<string, unknown> | null;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentBy: string | null;
  storeResponseId: string | null;
};

export type ReplyState = { status: 'none' | ReplyStatus; sentAt: number | null };

export type ReplyConfig = {
  enabled: boolean;
  envName: string;
  limits: { appstoreconnect: number; googleplay: number };
  sendsPerHour: number;
  translation: { available: boolean };
  templates: { max: number; placeholders: string[] };
};

export type ReplyTemplate = {
  id: string;
  name: string;
  body: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type SendReplyResult = { reply: ReplyDraft; review: Review; confirmedByReread: boolean };

// ---------------------------------------------------------------------------------------------
// Text

/** As the server does it before counting and hashing: LF line breaks, trimmed. */
export const normalizeReplyText = (value: string): string => value.replace(/\r\n?/g, '\n').trim();

// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const MARKUP = /<\/?[A-Za-z!][^>]*>/;

export type ReplyProblem = 'empty' | 'too_long' | 'control_characters' | 'markup';

/** The same plain-text rules as the server, to explain a problem before a request. The server decides. */
export function checkReply(
  text: string,
  limit: number,
): { ok: true } | { ok: false; problem: ReplyProblem; message: string } {
  const value = normalizeReplyText(text);
  if (value === '') return { ok: false, problem: 'empty', message: 'The reply is empty.' };
  if (CONTROL.test(value)) {
    return {
      ok: false,
      problem: 'control_characters',
      message:
        'The reply has a character that is not allowed in plain text (only line breaks are).',
    };
  }
  if (MARKUP.test(value)) {
    return {
      ok: false,
      problem: 'markup',
      message: 'The reply looks like it contains HTML tags. Replies are plain text.',
    };
  }
  if (value.length > limit) {
    return {
      ok: false,
      problem: 'too_long',
      message: `The reply is ${value.length} characters; this store allows at most ${limit}.`,
    };
  }
  return { ok: true };
}

export type LengthState = {
  count: number;
  limit: number;
  remaining: number;
  over: boolean;
  tone: 'ok' | 'warn' | 'bad';
  /** "312 of 350 characters" or "12 over the limit of 350". */
  label: string;
};

/** The counter under the text box. Counts what the server counts: the normalized text. */
export function lengthState(text: string, limit: number): LengthState {
  const count = normalizeReplyText(text).length;
  const remaining = limit - count;
  const over = remaining < 0;
  const tone = over ? 'bad' : remaining <= Math.max(10, Math.floor(limit * 0.1)) ? 'warn' : 'ok';
  const label = over
    ? `${-remaining} over the limit of ${limit}`
    : `${count} of ${limit} characters`;
  return { count, limit, remaining, over, tone, label };
}

export const limitFor = (config: Pick<ReplyConfig, 'limits'>, store: ReviewStore): number =>
  config.limits[store];

/** The draft box text when the person edits: has it changed from what is saved? */
export const draftChanged = (saved: ReplyDraft | null | undefined, text: string): boolean =>
  normalizeReplyText(text) !== (saved ? saved.text : '');

// ---------------------------------------------------------------------------------------------
// Who may do what, and why not

export type ReplyAvailability = {
  /** Writing, editing and deleting drafts: reviews.triage (a member and above). */
  canDraft: boolean;
  /** Publishing: reviews.reply (an admin and above). */
  canSend: boolean;
  /** Why something is disabled, in words, or null. */
  reason: string | null;
  /** 'off' when the server switch is off, 'rights' for a role, 'loading' until the config is known, 'ready'. */
  state: 'loading' | 'off' | 'rights' | 'ready';
};

export const REPLY_OFF_TEXT = `Replying is switched off on this server. Someone who runs it sets ${REPLY_ENV}=true and restarts it (see docs/deployment.md).`;

export function replyAvailability(
  config: Pick<ReplyConfig, 'enabled' | 'envName'> | null,
  role: Role,
): ReplyAvailability {
  if (!config) return { canDraft: false, canSend: false, reason: null, state: 'loading' };
  if (!config.enabled) {
    return {
      canDraft: false,
      canSend: false,
      reason: `Replying is switched off on this server. Someone who runs it sets ${config.envName || REPLY_ENV}=true and restarts it (see docs/deployment.md).`,
      state: 'off',
    };
  }
  const canDraft = can(role, 'reviews.triage');
  const canSend = can(role, 'reviews.reply');
  if (!canDraft)
    return {
      canDraft,
      canSend: false,
      reason: 'You can read reviews. A member can write reply drafts and an admin can send them.',
      state: 'rights',
    };
  if (!canSend)
    return {
      canDraft,
      canSend,
      reason: 'You can write a draft. Only an admin or owner can send a reply to the store.',
      state: 'rights',
    };
  return { canDraft, canSend, reason: null, state: 'ready' };
}

// ---------------------------------------------------------------------------------------------
// Status

export const replyStatusLabels: Record<ReplyStatus, string> = {
  draft: 'Draft',
  sending: 'Sending',
  sent: 'Reply sent',
  failed: 'Send failed',
  unknown: 'Outcome unknown',
};

export const replyStatusLabel = (status: ReplyState['status']): string =>
  status === 'none' ? 'No reply' : (replyStatusLabels[status] ?? status);

export const replyStatusTone = (
  status: ReplyState['status'],
): 'neutral' | 'info' | 'ok' | 'warn' | 'bad' =>
  status === 'sent'
    ? 'ok'
    : status === 'failed'
      ? 'bad'
      : status === 'unknown'
        ? 'warn'
        : status === 'sending'
          ? 'info'
          : 'neutral';

/** A draft that is being sent, or whose outcome is not known, may not be edited or deleted. */
export const isLocked = (status: ReplyState['status']): boolean =>
  status === 'sending' || status === 'unknown';

/** What the draft's status means for the person, one sentence. */
export function statusExplanation(draft: Pick<ReplyDraft, 'status' | 'errorCode'>): string | null {
  switch (draft.status) {
    case 'sending':
      return 'This reply is being sent right now. Nothing can be changed until the store answers.';
    case 'unknown':
      return 'The store did not confirm this reply and the review could not be read back to check. It was not sent again. Send again to check; this tool then reads the review first and only publishes if the reply is not there.';
    case 'failed':
      return 'The last send did not publish the reply. The draft is kept: fix the cause (or the text) and send again.';
    case 'sent':
      return 'This reply is published. Changing the text makes a new draft that replaces the published reply when sent.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The confirmation

export type ConfirmFacts = {
  /** Rows of the confirmation: the person reads these before the button is enabled. */
  rows: { label: string; value: string }[];
  /** The exact text that will be published. */
  text: string;
  count: number;
  limit: number;
  warning: string;
};

const storeNames: Record<ReviewStore, string> = {
  appstoreconnect: 'App Store',
  googleplay: 'Google Play',
};

/**
 * What the confirmation shows: the store, the app, the review (who wrote it, what rating) and the
 * count against the limit, then the exact text and the warning. The review text is not repeated.
 */
export function confirmFacts(input: {
  store: ReviewStore;
  appName: string;
  review: Pick<Review, 'rating' | 'authorName' | 'createdAt'>;
  draft: Pick<ReplyDraft, 'text' | 'length' | 'limit'>;
  replacing: boolean;
}): ConfirmFacts {
  const author =
    input.review.authorName && input.review.authorName.trim() !== ''
      ? input.review.authorName
      : 'an anonymous reviewer';
  return {
    rows: [
      { label: 'Store', value: storeNames[input.store] ?? input.store },
      { label: 'App', value: input.appName },
      { label: 'Review', value: `${input.review.rating} out of 5 stars by ${author}` },
      { label: 'Length', value: `${input.draft.length} of ${input.draft.limit} characters` },
      ...(input.replacing
        ? [{ label: 'Replaces', value: 'The reply that is already published for this review' }]
        : []),
    ],
    text: input.draft.text,
    count: input.draft.length,
    limit: input.draft.limit,
    warning: PUBLIC_WARNING,
  };
}

/** The send button is enabled only for a saved draft that fits, is not locked, and has been confirmed by a tick. */
export function canSendDraft(input: {
  draft: ReplyDraft | null | undefined;
  unsavedChanges: boolean;
  acknowledged: boolean;
  availability: ReplyAvailability;
}): boolean {
  const d = input.draft;
  return (
    !!d &&
    input.availability.canSend &&
    !input.unsavedChanges &&
    input.acknowledged &&
    d.length <= d.limit &&
    d.length > 0 &&
    d.status !== 'sending' &&
    d.status !== 'sent'
  );
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A message for a failed reply request. A store's own message is kept: it says what the store said. */
export function replyErrorMessage(
  error: unknown,
  action: 'draft' | 'send' | 'template' | 'translate' = 'send',
): string {
  if (!(error instanceof ApiError))
    return 'Something went wrong. Nothing was changed in the store as far as this tool knows. Reload the review to see its state.';
  const server = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'reply_disabled':
      return REPLY_OFF_TEXT;
    case 'forbidden':
      return action === 'send'
        ? 'Only an admin or owner can send replies.'
        : 'Only a member or above can write reply drafts.';
    case 'not_found':
      return 'This review no longer exists.';
    case 'stale_draft':
      return 'The draft changed after you opened this. Read the current text and confirm again.';
    case 'already_sent':
      return 'This reply was already sent. Nothing was sent again.';
    case 'send_in_progress':
      return 'A reply for this review is being sent right now. Wait a moment and look again.';
    case 'outcome_unknown':
      return 'The store did not confirm the reply and it could not be checked. Nothing was sent again. Look at the review in the store, then send again to check.';
    case 'send_failed':
      return `The reply was not published. ${server} The draft is kept.`
        .replace(/\s+/g, ' ')
        .trim();
    case 'invalid_reply':
    case 'invalid_template':
      return server || error.message;
    case 'no_draft':
      return 'There is no saved draft to send.';
    case 'rate_limited':
      return error.message;
    case 'store_auth':
      return `The store did not accept the credential. ${server}`.trim();
    case 'store_forbidden':
      return `The credential is not allowed to reply to reviews. ${server}`.trim();
    case 'store_not_found':
      return `The store has no such review any more. ${server}`.trim();
    case 'store_rejected':
      return `The store refused the reply. ${server}`.trim();
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return server || 'The credential of this app cannot be used. Check it under Credentials.';
    case 'too_many_templates':
      return server || 'A workspace can have at most 50 reply templates.';
    case 'template_not_found':
      return 'This template no longer exists.';
    case 'translation_unavailable':
      return 'Translation is not set up on this server.';
    case 'invalid_request':
      return error.message;
  }
  return error.message || 'The request failed. Try again.';
}

/** Whether a failure leaves the state of the reply uncertain, so the review should be loaded again. */
export const needsReload = (error: unknown): boolean =>
  error instanceof ApiError &&
  [
    'stale_draft',
    'already_sent',
    'send_in_progress',
    'outcome_unknown',
    'send_failed',
    'not_found',
  ].includes(error.code);

// ---------------------------------------------------------------------------------------------
// Templates

/** Appends a template's text to what is there, with a blank line between, without exceeding anything: the server checks the length. */
export function insertTemplateText(current: string, body: string): string {
  const base = normalizeReplyText(current);
  return base === '' ? body : `${base}\n\n${body}`;
}

/**
 * A preview of a template with its placeholders filled the way the server does: plain, one line,
 * at most 60 characters, "there" for a missing name. The server renders again when the draft is saved.
 */
export function previewTemplate(
  body: string,
  values: { author: string | null; app: string },
): string {
  const plain = (value: string | null, fallback: string): string => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    const cleaned = (value ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff<>{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .trim();
    return cleaned === '' ? fallback : cleaned;
  };
  return body.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (whole, name: string) =>
    name === 'author'
      ? plain(values.author, 'there')
      : name === 'app'
        ? plain(values.app, 'our app')
        : whole,
  );
}
