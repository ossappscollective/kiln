import { t } from './i18n/t.ts';

/** Small form checks that return a sentence a person can act on, or '' when the value is fine. */

/** `message` is the catalog key of the sentence for an empty value (a `k()` literal), for example `k('common:validation.nameRequired')`. */
export function requiredProblem(value: string, message: string): string {
  return value.trim() ? '' : t(message);
}

export function emailProblem(value: string): string {
  const v = value.trim();
  if (!v) return t('common:validation.emailRequired');
  // One @, something on each side, a dot in the domain. The server has the final say.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : t('common:validation.emailInvalid');
}

export function passwordProblem(value: string, min: number): string {
  if (!value) return t('common:validation.passwordRequired');
  // `count` is the minimum: it is the number the sentence's grammar follows ("at least 1 character", "at least 12 characters").
  return value.length >= min
    ? ''
    : t('common:validation.passwordTooShort', { count: min, length: value.length });
}
