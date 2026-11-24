/**
 * Pure parts of the readable Settings and Analytics forms (docs/design/readability.md, "Second pass"): a connection or a test is ONE
 * word, so the cards say "Added", "Missing" or "Works" and keep the sentence for the one line under it.
 */

import { t } from './i18n/t.ts';

export type WordTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface Word {
  tone: WordTone;
  label: string;
}

/**
 * The state of a credential for a provider, in one word. `changed`: the provider was changed and not saved yet, so the credential
 * shown would be the wrong one. A credential that is not required says `optionalLabel` ("Optional" or "Not needed").
 */
export function credentialWord(input: {
  configured: boolean;
  required: boolean;
  changed?: boolean;
  optionalLabel?: string;
}): Word {
  if (input.changed === true) return { tone: 'neutral', label: t('shell:word.saveFirst') };
  if (input.configured) return { tone: 'ok', label: t('shell:word.added') };
  if (input.required) return { tone: 'warn', label: t('shell:word.missing') };
  return { tone: 'neutral', label: input.optionalLabel ?? t('shell:word.optional') };
}

/** The result of a test, in one word: not run yet, running, worked, or did not. */
export function testWord(state: { testing?: boolean; ok: boolean | null }): Word {
  if (state.testing === true) return { tone: 'neutral', label: t('shell:word.testing') };
  if (state.ok === null) return { tone: 'neutral', label: t('shell:word.notTested') };
  return state.ok
    ? { tone: 'ok', label: t('shell:word.works') }
    : { tone: 'bad', label: t('shell:word.failed') };
}

/**
 * The answer of "Test the bucket" in one word. The sentence of the answer (a fixed vocabulary) stays under it: the word says whether to
 * act, the sentence says what to do.
 */
export function bucketTestWord(
  result: { code: string; ok: boolean } | null,
  testing = false,
): Word {
  if (testing) return { tone: 'neutral', label: t('shell:word.testing') };
  if (result === null) return { tone: 'neutral', label: t('shell:word.notTested') };
  if (result.code === 'ok') return { tone: 'ok', label: t('shell:word.works') };
  if (result.ok) return { tone: 'neutral', label: t('shell:word.reachable') };
  return { tone: 'warn', label: t('shell:word.failed') };
}
