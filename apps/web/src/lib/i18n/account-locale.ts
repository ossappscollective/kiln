/**
 * The language in the account (docs/i18n-server.md, ADR 0045 amendment 2026-11-22). The server keeps one nullable `locale` per person
 * so emails sent without a request (alerts, the digest) come in their language. The browser's own choice (`kiln.locale`) stays what
 * decides this screen; these two helpers only keep the account in step with it:
 *  - `saveAccountLocale`: after a signed-in person picks a language, tell the server (best effort, never blocks or throws);
 *  - `adoptAccountLocale`: on sign-in, a person who has a saved account language and no choice in this browser gets that language.
 * Pure: the browser and the network are passed in, so tests need neither.
 */
import { isAvailableLocale } from './locales.ts';

export type AccountLocaleDeps = {
  /** The language saved in this browser, or null. */
  stored: () => string | null;
  /** Makes a language active and remembers it in this browser. */
  activate: (code: string) => Promise<boolean>;
};

/** Adopts the account language when this browser has no choice yet. Resolves to whether it changed the language. */
export async function adoptAccountLocale(
  accountLocale: string | null | undefined,
  deps: AccountLocaleDeps,
): Promise<boolean> {
  if (!isAvailableLocale(accountLocale)) return false;
  if (deps.stored() !== null) return false;
  return deps.activate(accountLocale);
}

/** Tells the server the language just chosen. A failure (offline, signed out, an old server) is ignored: the browser keeps the choice. */
export async function saveAccountLocale(
  code: string,
  save: (code: string) => Promise<unknown>,
): Promise<boolean> {
  if (!isAvailableLocale(code)) return false;
  try {
    await save(code);
    return true;
  } catch {
    return false;
  }
}
