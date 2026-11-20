/**
 * The one-sentence explanations on the sign-in and confirmation screens (docs/design/readability.md). Pure: the
 * dialogs only show what these return, so the wording is tested here. ES2017 only.
 */
import type { StepUpFactor } from './step-up.ts';
import type { LoginMethod } from './two-factor.ts';

const WAY_LABELS: Record<StepUpFactor, string> = {
  passkey: 'your passkey',
  password: 'your password',
  totp: 'an authenticator code',
  email: 'an emailed code',
  recovery: 'a recovery code',
};

/** The order a person is offered the ways in (the dialog's primary factor first, a recovery code last). */
const WAY_ORDER: readonly StepUpFactor[] = ['passkey', 'password', 'totp', 'email', 'recovery'];

/** "your passkey or your password", "your password, an authenticator code or a recovery code"; '' when no way is usable. */
export function waysPhrase(factors: readonly StepUpFactor[], passkeySupported: boolean): string {
  const usable = WAY_ORDER.filter(
    (way) => factors.indexOf(way) >= 0 && (way !== 'passkey' || passkeySupported),
  ).map((way) => WAY_LABELS[way]);
  if (usable.length === 0) return '';
  if (usable.length === 1) return usable[0];
  return `${usable.slice(0, -1).join(', ')} or ${usable[usable.length - 1]}`;
}

/** What the step-up dialog is for, in one sentence (the title already names the action). */
export function confirmSentence(
  factors: readonly StepUpFactor[],
  passkeySupported: boolean,
): string {
  const ways = waysPhrase(factors, passkeySupported);
  return ways ? `Use ${ways} to confirm this one action.` : 'This action needs to be confirmed again.';
}

/** How long a confirmation lasts: one quiet line under the form. */
export const STEP_UP_VALIDITY = 'It works for this one action, for a few minutes.';

/** The quiet link that switches to another second step while signing in. */
export const otherWayLabel = (method: LoginMethod): string =>
  method === 'totp'
    ? 'Use your authenticator app'
    : method === 'email'
      ? 'Email me a code'
      : 'Use a recovery code';

/** One sentence under each choice when a second step has to be set up. */
export const enrollChoiceHint = (method: LoginMethod): string =>
  method === 'totp'
    ? 'Six digit codes from an app on your phone, even without a signal.'
    : method === 'email'
      ? 'A six digit code sent to the address on your account.'
      : 'Codes you saved when you set a second step up.';
