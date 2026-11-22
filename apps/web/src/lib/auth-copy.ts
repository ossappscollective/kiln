/**
 * The one-sentence explanations on the sign-in and confirmation screens (docs/design/readability.md). Pure: the
 * dialogs only show what these return, so the wording is tested here. ES2017 only.
 */
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { StepUpFactor } from './step-up.ts';
import type { LoginMethod } from './two-factor.ts';

const WAY_LABELS: Record<StepUpFactor, string> = {
  passkey: k('auth:way.passkey'),
  password: k('auth:way.password'),
  totp: k('auth:way.totp'),
  email: k('auth:way.email'),
  recovery: k('auth:way.recovery'),
};

/** The order a person is offered the ways in (the dialog's primary factor first, a recovery code last). */
const WAY_ORDER: readonly StepUpFactor[] = ['passkey', 'password', 'totp', 'email', 'recovery'];

/** "your passkey or your password", "your password, an authenticator code, or a recovery code"; '' when no way is usable. */
export function waysPhrase(factors: readonly StepUpFactor[], passkeySupported: boolean): string {
  const usable = WAY_ORDER.filter(
    (way) => factors.indexOf(way) >= 0 && (way !== 'passkey' || passkeySupported),
  ).map((way) => t(WAY_LABELS[way]));
  return formatList(usable, { type: 'disjunction' });
}

/** What the step-up dialog is for, in one sentence (the title already names the action). */
export function confirmSentence(
  factors: readonly StepUpFactor[],
  passkeySupported: boolean,
): string {
  const ways = waysPhrase(factors, passkeySupported);
  return ways ? t('auth:confirm.sentence', { ways }) : t('auth:confirm.again');
}

/** How long a confirmation lasts: one quiet line under the form. */
export const stepUpValidity = (): string => t('auth:confirm.validity');

const OTHER_WAY: Record<LoginMethod, string> = {
  totp: k('auth:otherWay.totp'),
  email: k('settings:twoFactor.emailMe'),
  recovery: k('auth:otherWay.recovery'),
};

/** The quiet link that switches to another second step while signing in. */
export const otherWayLabel = (method: LoginMethod): string => t(OTHER_WAY[method]);

const ENROLL_HINT: Record<LoginMethod, string> = {
  totp: k('auth:enrollHint.totp'),
  email: k('auth:enrollHint.email'),
  recovery: k('auth:enrollHint.recovery'),
};

/** One sentence under each choice when a second step has to be set up. */
export const enrollChoiceHint = (method: LoginMethod): string => t(ENROLL_HINT[method]);
