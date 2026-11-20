/**
 * Pure parts of the readable Settings and Analytics forms (docs/design/readability.md, "Second pass"): a connection or a test is ONE
 * word, so the cards say "Added", "Missing" or "Works" and keep the sentence for the one line under it.
 */

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
  if (input.changed === true) return { tone: 'neutral', label: 'Save first' };
  if (input.configured) return { tone: 'ok', label: 'Added' };
  if (input.required) return { tone: 'warn', label: 'Missing' };
  return { tone: 'neutral', label: input.optionalLabel ?? 'Optional' };
}

/** The result of a test, in one word: not run yet, running, worked, or did not. */
export function testWord(state: { testing?: boolean; ok: boolean | null }): Word {
  if (state.testing === true) return { tone: 'neutral', label: 'Testing' };
  if (state.ok === null) return { tone: 'neutral', label: 'Not tested' };
  return state.ok ? { tone: 'ok', label: 'Works' } : { tone: 'bad', label: 'Failed' };
}
