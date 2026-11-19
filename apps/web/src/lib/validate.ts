/** Small form checks that return a sentence a person can act on, or '' when the value is fine. */

export function requiredProblem(value: string, what: string): string {
  return value.trim() ? '' : `Enter ${what}.`;
}

export function emailProblem(value: string): string {
  const v = value.trim();
  if (!v) return 'Enter your email address.';
  // One @, something on each side, a dot in the domain. The server has the final say.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
    ? ''
    : 'Enter an email address like name@example.com.';
}

export function passwordProblem(value: string, min: number): string {
  if (!value) return 'Enter a password.';
  return value.length >= min ? '' : `Use at least ${min} characters. You have ${value.length}.`;
}
