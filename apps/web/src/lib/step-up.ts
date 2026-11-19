/**
 * Step-up confirmation, the pure part (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md): what the
 * server's `step_up_required` answer means, plain sentences for every fixed code, the conversions between the
 * server's base64url JSON and the browser's WebAuthn buffers, and `withStepUp`, the one place a call is retried.
 * No DOM, no fetch: the dialog and the API client use these. ES2017 only (the web is compiled for it).
 */

export type StepUpAction =
  | 'store.publish'
  | 'store.submit'
  | 'store.release'
  | 'rollout'
  | 'internal_sharing'
  | 'analytics.enable_apple'
  | 'credential.delete'
  | 'flags'
  | 'store.push_draft';

/** The classes a policy can cover, in the server's order. A server test pins this list to the server's. */
export const STEP_UP_ACTIONS: readonly StepUpAction[] = [
  'store.publish',
  'store.submit',
  'store.release',
  'rollout',
  'internal_sharing',
  'analytics.enable_apple',
  'credential.delete',
  'flags',
  'store.push_draft',
];

/** Covered when the policy is switched on and nothing else was chosen: everything but the draft push. */
export const DEFAULT_COVERED: readonly StepUpAction[] = STEP_UP_ACTIONS.filter((a) => a !== 'store.push_draft');

const ACTION_LABELS: Record<string, string> = {
  'store.publish': 'Publish to the stores',
  'store.submit': 'Submit for store review',
  'store.release': 'Release to users',
  rollout: 'Change a live rollout',
  internal_sharing: 'Google Play internal app sharing',
  'analytics.enable_apple': 'Turn on Apple analytics reports',
  'credential.delete': 'Delete a credential',
  flags: 'Turn a feature on',
  'store.push_draft': 'Write a store draft',
  'step_up.manage': 'Change how you confirm',
};

export const stepUpActionLabel = (action: string): string => ACTION_LABELS[action] || 'This action';

export type StepUpFactor = 'passkey' | 'password' | 'recovery' | 'totp' | 'email';
export type StepUpTarget = { id?: string; hash?: string };
export type StepUpNeed = { action: string; target: StepUpTarget; factors: StepUpFactor[]; reason: string };

export type StepUpPasskey = { id: string; name: string; createdAt: number; lastUsedAt: number | null; transports: string[] };
export type StepUpPolicy = { mode: 'off' | 'hard_actions'; actions: StepUpAction[]; unattended: StepUpAction[]; classes?: StepUpAction[]; defaults?: StepUpAction[] };
export type RecoveryStatus = { remaining: number; total: number; generatedAt: number | null };
export type StepUpStatus = {
  policy: StepUpPolicy;
  factors: { passkeys: StepUpPasskey[]; password: { kind: 'account' | 'confirmation' } | null; confirmationPasswordSettable: boolean };
  enrolled: boolean;
  recovery?: RecoveryStatus;
  lockedUntil: number | null;
  supported: { webauthn: boolean; rpId: string; maxPasskeys: number };
  grantTtlSeconds: number;
};

type ErrorLike = { status?: unknown; code?: unknown; body?: unknown };

/** The need behind a `step_up_required` answer, or undefined for any other error (which is never retried). */
export function stepUpNeed(error: unknown, hash?: string): StepUpNeed | undefined {
  const e = error as ErrorLike | null;
  if (!e || typeof e !== 'object' || e.code !== 'step_up_required') return undefined;
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
  const factors = Array.isArray(body.factors) ? (body.factors.filter((f) => f === 'passkey' || f === 'password' || f === 'recovery' || f === 'totp' || f === 'email') as StepUpFactor[]) : [];
  const target: StepUpTarget = {};
  if (typeof body.target === 'string' && body.target) target.id = body.target;
  if (hash) target.hash = hash;
  return { action: typeof body.action === 'string' ? body.action : '', target, factors, reason: typeof body.reason === 'string' ? body.reason : 'missing' };
}

/**
 * Runs `run` once. If the server answers `step_up_required`, asks for a confirmation and runs the SAME call once more
 * with the grant. A second refusal, a cancelled confirmation and every other error go to the caller unchanged: nothing
 * else is ever retried. `hash` is the preview or plan hash the call sends, so the grant is bound to it.
 */
export async function withStepUp<T>(
  run: (grant?: string) => Promise<T>,
  ask: (need: StepUpNeed) => Promise<string | undefined>,
  hash?: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const need = stepUpNeed(error, hash);
    if (!need) throw error;
    const grant = await ask(need);
    if (grant === undefined) throw error;
    return run(grant);
  }
}

/** Plain words for each fixed code the step-up routes answer with. Unknown codes get no sentence here (undefined). */
export function stepUpMessage(code: string, retryAfter?: number): string | undefined {
  switch (code) {
    case 'step_up_required':
      return 'This needs your confirmation first. Nothing was changed.';
    case 'step_up_required_human':
      return 'This needs a person to confirm it in the app. An API token cannot.';
    case 'step_up_not_enrolled':
      return 'This action needs a confirmation, and you have no way to confirm yet. Add a passkey, an authenticator app or a confirmation password in Settings, Security.';
    case 'step_up_failed':
      return 'That did not confirm. Try again.';
    case 'step_up_locked': {
      const wait = retryAfter && retryAfter > 0 ? retryAfter : 60;
      const text = wait < 60 ? `${Math.ceil(wait)} seconds` : `${Math.ceil(wait / 60)} minute${Math.ceil(wait / 60) === 1 ? '' : 's'}`;
      return `Too many wrong attempts. Try again in ${text}.`;
    }
    case 'step_up_busy':
      return 'Another confirmation is in progress. Try again in a moment.';
    case 'factor_not_enrolled':
      return 'That way of confirming is not set up. For recovery codes, add a passkey or a confirmation password first, or you may have used every code.';
    case 'webauthn_unavailable':
      return 'Passkeys need https, or http://localhost. Use a password instead.';
    case 'challenge_invalid':
      return 'That request expired. Start again.';
    case 'passkey_rejected':
      return 'This passkey could not be added.';
    case 'account_password_used':
      return 'This server confirms with your account password. Change that password instead.';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Recovery codes (docs/api/step-up.md, "Recovery codes")

export const RECOVERY_CODE_HINT = 'Each recovery code works once. Wrong ones count like wrong passwords.';
const RECOVERY_SYMBOLS = 20;

/** What was typed as the symbols it stands for: case, dashes and spaces do not matter (the server folds O to 0 and I, L to 1). */
export const recoverySymbols = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, '');

/** True when the text has the 20 symbols of a code. A wrong code counts toward the lockout, so a short one is not sent. */
export const recoveryCodeComplete = (text: string): boolean => /^[0-9A-Z]+$/.test(recoverySymbols(text)) && recoverySymbols(text).length === RECOVERY_SYMBOLS;

/** The code as it is shown, in four groups of five: `XXXXX-XXXXX-XXXXX-XXXXX`. Anything that is not 20 symbols is returned trimmed. */
export function formatRecoveryCode(text: string): string {
  const symbols = recoverySymbols(text);
  if (!recoveryCodeComplete(text)) return text.trim();
  return [0, 5, 10, 15].map((i) => symbols.slice(i, i + 5)).join('-');
}

/** The sentence for a recovery code that did not confirm (a fixed code, never the server's text). */
export function recoveryFailureMessage(error: unknown): string | undefined {
  const e = error as { code?: unknown; body?: unknown } | null;
  if (!e || typeof e !== 'object' || e.code !== 'step_up_failed') return undefined;
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
  return body.reason === 'invalid_recovery_code' ? 'That recovery code did not work. Check it and try again. A code that was used before no longer works.' : undefined;
}

/** The Security card's line about the codes that are left. */
export function recoverySummary(recovery: RecoveryStatus | undefined): string {
  if (!recovery || recovery.total === 0) return 'No recovery codes yet. Make a set and keep it offline, so a lost passkey or password does not lock you out.';
  if (recovery.remaining === 0) return 'Every recovery code has been used. Make a new set.';
  if (recovery.remaining <= 3) return `${recovery.remaining} of ${recovery.total} recovery codes left. Make a new set soon.`;
  return `${recovery.remaining} of ${recovery.total} recovery codes left.`;
}

/** The text file the person can save: the codes, a heading, the date. Never includes anything but the codes. */
export function recoveryCodesText(codes: readonly string[], generatedAt: number): string {
  const day = new Date(generatedAt).toISOString().slice(0, 10);
  return ['Mobile Release Manager recovery codes', `Made ${day}`, '', ...codes, '', 'Each code works once. Keep this file offline. Making a new set stops these from working.', ''].join('\n');
}

export const RECOVERY_FILE_NAME = 'mrm-recovery-codes.txt';

/** What went wrong in the browser's WebAuthn call, as a sentence. The browser's own text is never shown. */
export function webauthnFailureMessage(error: unknown): string {
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The confirmation was cancelled or timed out. Try again.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for this app.';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'This window cannot use passkeys. Use your password instead.';
  return 'Your device could not confirm. Try again, or use your password.';
}

// ---------------------------------------------------------------------------------------------
// WebAuthn conversions

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const text = padded + '==='.slice((padded.length + 3) % 4);
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = '';
  for (let i = 0; i < view.length; i++) raw += String.fromCharCode(view[i] ?? 0);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** The server's creation options (base64url strings) as `navigator.credentials.create` wants them (buffers). */
export function creationOptionsFromServer(publicKey: Json): Json {
  const user = (publicKey.user || {}) as Json;
  return {
    ...publicKey,
    challenge: base64urlToBytes(String(publicKey.challenge)),
    user: { ...user, id: base64urlToBytes(String(user.id)) },
    excludeCredentials: asArray(publicKey.excludeCredentials).map((c) => ({ ...c, id: base64urlToBytes(String(c.id)) })),
  };
}

/** The server's assertion options as `navigator.credentials.get` wants them. */
export function requestOptionsFromServer(publicKey: Json): Json {
  return {
    ...publicKey,
    challenge: base64urlToBytes(String(publicKey.challenge)),
    allowCredentials: asArray(publicKey.allowCredentials).map((c) => ({ ...c, id: base64urlToBytes(String(c.id)) })),
  };
}

type Attestation = { id: string; rawId: ArrayBuffer; response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer; getTransports?: () => string[] } };
type Assertion = { id: string; rawId: ArrayBuffer; response: { clientDataJSON: ArrayBuffer; authenticatorData: ArrayBuffer; signature: ArrayBuffer } };

/** What the registration verify route takes. The id is re-encoded from the raw bytes, never trusted from a string. */
export function attestationToServer(credential: Attestation) {
  const transports = typeof credential.response.getTransports === 'function' ? credential.response.getTransports() : [];
  return {
    id: bytesToBase64url(credential.rawId),
    clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
    attestationObject: bytesToBase64url(credential.response.attestationObject),
    transports,
  };
}

export function assertionToServer(credential: Assertion) {
  return {
    id: bytesToBase64url(credential.rawId),
    clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
    authenticatorData: bytesToBase64url(credential.response.authenticatorData),
    signature: bytesToBase64url(credential.response.signature),
  };
}

/**
 * Whether this window can run a passkey ceremony: a secure context and `PublicKeyCredential` with `navigator.credentials`.
 * Pass the globals in (`window`), so this is testable. The desktop shell's web view may not offer it (UNVERIFIED):
 * then the dialog offers the password and says why.
 */
export function webauthnSupported(env: { isSecureContext?: boolean; PublicKeyCredential?: unknown; navigator?: { credentials?: { get?: unknown; create?: unknown } } }): boolean {
  if (env.isSecureContext === false) return false;
  if (typeof env.PublicKeyCredential !== 'function') return false;
  const credentials = env.navigator && env.navigator.credentials;
  return !!credentials && typeof credentials.get === 'function' && typeof credentials.create === 'function';
}

/** Which way to offer first: a passkey when there is one and this window can use it, otherwise the password. */
export function primaryFactor(factors: readonly StepUpFactor[], supported: boolean): StepUpFactor | undefined {
  if (supported && factors.indexOf('passkey') >= 0) return 'passkey';
  if (factors.indexOf('password') >= 0) return 'password';
  if (factors.indexOf('totp') >= 0) return 'totp';
  if (factors.indexOf('email') >= 0) return 'email';
  return undefined;
}

/** True when the only enrolled way is a passkey and this window cannot use one: the person is stuck here and needs to be told. */
export function passkeyOnlyButUnsupported(factors: readonly StepUpFactor[], supported: boolean): boolean {
  return !supported && factors.indexOf('passkey') >= 0 && factors.indexOf('password') < 0 && factors.indexOf('totp') < 0 && factors.indexOf('email') < 0;
}

// ---------------------------------------------------------------------------------------------
// The policy as a form

/** Toggles one class in the covered list, keeping the server's order. */
export function toggleAction(list: readonly StepUpAction[], action: StepUpAction, on: boolean): StepUpAction[] {
  return STEP_UP_ACTIONS.filter((a) => (a === action ? on : list.indexOf(a) >= 0));
}

/** A sentence for the Security card about the state of the policy and the person's ways to confirm. */
export function securitySummary(status: Pick<StepUpStatus, 'policy' | 'enrolled'>): string {
  if (status.policy.mode === 'off') return 'Confirmation is off. Anyone who can use this app can publish, release and delete without being asked again.';
  if (!status.enrolled) return 'Confirmation is on, but you have no way to confirm yet, so hard actions are refused for you. Add a passkey or a confirmation password.';
  return 'Confirmation is on: hard actions ask you to confirm with a passkey or a password first.';
}
