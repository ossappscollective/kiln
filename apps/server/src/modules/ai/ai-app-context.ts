import {
  type AiAppContext,
  type AiFlag,
  type AiProposal,
  aiContextKeys,
  emptyAiAppContext,
  findBannedWord,
  isEmptyAiAppContext,
  normalizeAiAppContext,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { recordAudit } from '../../services/audit.ts';
import { type AiActor, type AiFailure, aiFail } from './ai-config.ts';

/**
 * The AI context of an app (docs/adr/0024-ai-features.md): what a person tells the assistant ONCE about an app (what it is, who it is
 * for, the tone, the words never to use, the names to keep). It is stored per app (`ai_app_context`, migration 40), edited with the
 * right to change the app (`apps.write`) and sent with EVERY task of that app, but only the parts that are filled in.
 *
 * It is text a person typed for this purpose: never a credential, never review text. It is also the one place the rules of the
 * workspace's voice live, so the checks that follow (a banned word in a draft, a reply that reads like a promise or holds an email
 * address) are here too: they run on every text a model writes, after the model, because a prompt is a request and not a guarantee.
 */

export type StoredAiContext = {
  context: AiAppContext;
  updatedAt: number | null;
  updatedBy: string | null;
};

function parse(raw: unknown): AiAppContext {
  try {
    const checked = normalizeAiAppContext(JSON.parse(String(raw)));
    return checked.ok ? checked.value : emptyAiAppContext();
  } catch {
    return emptyAiAppContext();
  }
}

export async function getAppContext(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<StoredAiContext> {
  const [row] = await sql.query(
    'SELECT context, updated_at, updated_by FROM ai_app_context WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  if (!row) return { context: emptyAiAppContext(), updatedAt: null, updatedBy: null };
  return {
    context: parse(row.context),
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

/**
 * Replaces the context of an app (a missing field is cleared; an all-empty context deletes the row). Validated, then audited with the
 * NAMES of the fields that changed and nothing else: the text is the developer's brand copy, but it is not needed in a log.
 */
export async function setAppContext(
  db: Database,
  input: { workspaceId: string; appId: string; actor: AiActor; context: unknown; at: number },
): Promise<{ ok: true; stored: StoredAiContext } | AiFailure> {
  const checked = normalizeAiAppContext(input.context);
  if (!checked.ok)
    return aiFail(400, 'invalid_request', 'The AI context is not valid.', {
      issues: checked.issues,
    });
  const next = checked.value;
  await db.transaction(async (tx) => {
    const before = (await getAppContext(tx, input.workspaceId, input.appId)).context;
    const changed = aiContextKeys.filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]),
    );
    if (changed.length === 0) return;
    if (isEmptyAiAppContext(next)) {
      await tx.execute('DELETE FROM ai_app_context WHERE workspace_id = ? AND app_id = ?', [
        input.workspaceId,
        input.appId,
      ]);
    } else {
      const json = JSON.stringify(next);
      const updated = await tx.execute(
        'UPDATE ai_app_context SET context = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ?',
        [json, input.actor.id, input.at, input.workspaceId, input.appId],
      );
      if (Number(updated) === 0) {
        await tx.execute(
          'INSERT INTO ai_app_context (app_id, workspace_id, context, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
          [input.appId, input.workspaceId, json, input.actor.id, input.at],
        );
      }
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'ai.app_context_update',
      target: { type: 'app', id: input.appId },
      detail: { appId: input.appId, fields: changed },
      at: input.at,
    });
  });
  return { ok: true, stored: await getAppContext(db, input.workspaceId, input.appId) };
}

/**
 * What goes into a task's input: only the fields that are filled in, under short names. `undefined` when there is nothing to send, so an
 * app without a context sends exactly what it sent before.
 */
export function contextForPrompt(context: AiAppContext): Record<string, unknown> | undefined {
  if (isEmptyAiAppContext(context)) return undefined;
  const out: Record<string, unknown> = {};
  if (context.about !== '') out.about = context.about;
  if (context.audience !== '') out.audience = context.audience;
  if (context.tone !== '') out.tone = context.tone;
  if (context.brandVoice !== '') out.brandVoice = context.brandVoice;
  if (context.doList.length > 0) out.do = context.doList;
  if (context.dontList.length > 0) out.dont = context.dontList;
  if (context.bannedWords.length > 0) out.neverUseWords = context.bannedWords;
  if (context.brandTerms.length > 0) out.keepExactlyAsWritten = context.brandTerms;
  return out;
}

/** The task's input with the app context added under `appContext` (when there is one). Inputs that are not plain objects are left alone. */
export function withAppContext(input: unknown, context: AiAppContext): unknown {
  const block = contextForPrompt(context);
  if (block === undefined || typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  return { ...(input as Record<string, unknown>), appContext: block };
}

// ---------------------------------------------------------------------------------------------
// Checks on text a model wrote

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/;
const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|app|de|fr|es|co)\b\/?/i;
const PHONE = /(?:\+|\b)\d[\d\s().-]{6,}\d/;

/** An email address, a link or a phone number: a reply never holds one. */
export const hasPersonalData = (text: string): boolean =>
  EMAIL.test(text) || LINK.test(text) || PHONE.test(text);

const PROMISE = [
  /\brefund/i,
  /\bmoney[- ]back\b/i,
  /\breimburs/i,
  /\bcompensat/i,
  /\bguarantee/i,
  /\bwe promise\b/i,
  /\b(will|going to) be (fixed|resolved|released|added)\b/i,
  /\bnext (update|release|version)\b/i,
  /\bwithin \d+ (hours?|days?|weeks?)\b/i,
  /\b(legal|lawsuit|lawyer|liable|liability)\b/i,
  /\b(erstattung|rückerstattung|rueckerstattung|entschädigung|garantie)/i,
  /\b(remboursement|rembours|garantie|indemnis)/i,
  /\b(reembolso|devolución|garantizamos|prometemos)/i,
  /\b(rimborso|garantiamo|prometiamo)/i,
  /\b(reembolso|garantimos|prometemos)\b/i,
];
/** Reads like a promise of money, a date, a fix or a legal position. A heuristic: it flags, a person decides. */
export const looksLikePromise = (text: string): boolean => PROMISE.some((re) => re.test(text));

type Texty = { flags: AiFlag[]; acceptable: boolean };

function ban(item: Texty, text: string, context: AiAppContext): void {
  if (context.bannedWords.length > 0 && findBannedWord(text, context.bannedWords) !== undefined) {
    if (!item.flags.includes('banned_term')) item.flags.push('banned_term');
    item.acceptable = false;
  }
}

/**
 * The rules of the app's context applied to what a model proposed, after the model and before anyone sees it: a text that holds a
 * banned word cannot be accepted (it stays readable and says why). Insights are not texts to accept: they are left alone, apart from
 * the draft release notes of `fix_next`, which are checked like any other text.
 */
export function applyContextRules(proposal: AiProposal, context: AiAppContext): AiProposal {
  if (context.bannedWords.length === 0) return proposal;
  switch (proposal.kind) {
    case 'keywords':
      for (const item of proposal.items) ban(item, item.term, context);
      break;
    case 'listing_text':
      for (const field of proposal.fields) ban(field, field.text, context);
      break;
    case 'reply_draft':
      ban(proposal, proposal.text, context);
      break;
    case 'listing_variants':
      for (const field of proposal.fields)
        for (const variant of field.variants) ban(variant, variant.text, context);
      break;
    case 'insight':
      if (
        proposal.insight === 'fix_next' &&
        findBannedWord(proposal.releaseNotes, context.bannedWords) !== undefined
      ) {
        if (!proposal.releaseNotesFlags.includes('banned_term'))
          proposal.releaseNotesFlags.push('banned_term');
      }
      break;
  }
  return proposal;
}
