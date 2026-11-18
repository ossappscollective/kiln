/**
 * The result of checking a credential against the service it belongs to, without changing
 * anything there. Shown to people, so `message` is a sentence they can act on and `details`
 * are short extra facts (the account name, the permissions that were found). Never put the
 * secret, a token or a private key in either.
 */
export type VerifyResult = {
  ok: boolean;
  message: string;
  details?: string[];
};

export type VerifyOptions = {
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
};
