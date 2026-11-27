import type { ReadinessFinding } from '../listing/draft-readiness.ts';
import { compareDottedVersions, isDottedVersion } from './store-version.ts';

/**
 * App Review Information of an App Store version (`appStoreReviewDetail` in the App Store Connect API): the pure rules shared by the
 * server and the web app (docs/api/review-information.md). The detail belongs to ONE version: a version created through the API starts
 * without the one of the previous version, so this module decides what is carried over, what is missing, and what may be shown.
 *
 * Apple's documentation names the attributes App Review needs: the contact first and last name, phone number and email address
 * (https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details). A demo account is needed when the review
 * detail says it is required. Nothing here talks to a store, and nothing here keeps a name, a phone number, an email address or a
 * password anywhere but in the value it is given: the checks read presence only (`ReviewDetailFacts`), the display is masked
 * (`maskedReviewSummary`). Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** The text attributes of a review detail, in the order they are written. */
export const REVIEW_TEXT_FIELDS = [
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'contactEmail',
  'demoAccountName',
  'demoAccountPassword',
  'notes',
] as const;
export type ReviewTextField = (typeof REVIEW_TEXT_FIELDS)[number];

/** The four attributes App Review needs a value for. */
export const REVIEW_CONTACT_FIELDS: readonly ReviewTextField[] = [
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'contactEmail',
];

/** A review detail as the store holds it. SERVER ONLY: it holds personal data and a password, so it never goes to a log or the browser. */
export type ReviewDetail = {
  text: Record<ReviewTextField, string | null>;
  demoAccountRequired: boolean | null;
};

/** What a check needs: which values are there, never the values. */
export type ReviewDetailFacts = {
  /** The version has a review detail at all. */
  exists: boolean;
  contactFirstName: boolean;
  contactLastName: boolean;
  contactPhone: boolean;
  contactEmail: boolean;
  demoAccountRequired: boolean | null;
  demoAccountName: boolean;
  demoAccountPassword: boolean;
};

export const isBlankReviewValue = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === '';

export const emptyReviewDetail = (): ReviewDetail => ({
  text: {
    contactFirstName: null,
    contactLastName: null,
    contactPhone: null,
    contactEmail: null,
    demoAccountName: null,
    demoAccountPassword: null,
    notes: null,
  },
  demoAccountRequired: null,
});

/** Whether any text of the detail is filled in (the contact, the demo account or the notes). */
export function reviewDetailHasContent(detail: ReviewDetail | null | undefined): boolean {
  if (!detail) return false;
  return REVIEW_TEXT_FIELDS.some((f) => !isBlankReviewValue(detail.text[f]));
}

/** The presence facts of a detail (null: the version has none). */
export function reviewFactsOf(detail: ReviewDetail | null | undefined): ReviewDetailFacts {
  const has = (f: ReviewTextField): boolean => !!detail && !isBlankReviewValue(detail.text[f]);
  return {
    exists: !!detail,
    contactFirstName: has('contactFirstName'),
    contactLastName: has('contactLastName'),
    contactPhone: has('contactPhone'),
    contactEmail: has('contactEmail'),
    demoAccountRequired: detail ? detail.demoAccountRequired : null,
    demoAccountName: has('demoAccountName'),
    demoAccountPassword: has('demoAccountPassword'),
  };
}

const CONTACT_FACT: Readonly<Record<string, keyof ReviewDetailFacts>> = {
  contactFirstName: 'contactFirstName',
  contactLastName: 'contactLastName',
  contactPhone: 'contactPhone',
  contactEmail: 'contactEmail',
};

/** The contact attributes App Review needs that the facts say are missing (field names, in the documented order). */
export function missingContactFields(facts: ReviewDetailFacts): ReviewTextField[] {
  return REVIEW_CONTACT_FIELDS.filter((f) => facts[CONTACT_FACT[f] as keyof ReviewDetailFacts] !== true);
}

const NAMES: Readonly<Record<string, string>> = {
  contactFirstName: 'first name',
  contactLastName: 'last name',
  contactPhone: 'phone number',
  contactEmail: 'email address',
};

/**
 * The submit checks of the review information, judged from presence facts. Null or undefined facts mean the store did not say (the read
 * failed or the store has no such resource): nothing is guessed and nothing is reported. Pure and total. The messages are English
 * sentences without any value of the detail.
 *
 * - `no_review_contact`: a contact first name, last name, phone number or email address is missing or blank (whitespace only).
 * - `no_review_demo_account`: the detail says a demo account is required and its user name or password is blank.
 */
export function evaluateReviewInformation(
  facts: ReviewDetailFacts | null | undefined,
): ReadinessFinding[] {
  if (!facts) return [];
  const out: ReadinessFinding[] = [];
  const missing = missingContactFields(facts);
  if (missing.length > 0) {
    const names = missing.map((f) => NAMES[f] as string).join(', ');
    out.push({
      code: 'no_review_contact',
      severity: 'blocking',
      message: facts.exists
        ? `The App Review contact information is incomplete: ${names} ${missing.length === 1 ? 'is' : 'are'} missing.`
        : 'The version has no App Review contact information (first name, last name, phone number and email address).',
      item: 'contact',
      params: { missing: missing.join(',') },
    });
  }
  if (
    facts.demoAccountRequired === true &&
    (!facts.demoAccountName || !facts.demoAccountPassword)
  ) {
    out.push({
      code: 'no_review_demo_account',
      severity: 'blocking',
      message:
        'App Review information says a demo account is required, but its user name or password is empty.',
      item: 'demo_account',
      params: {
        missing: [
          facts.demoAccountName ? '' : 'demoAccountName',
          facts.demoAccountPassword ? '' : 'demoAccountPassword',
        ]
          .filter((s) => s !== '')
          .join(','),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Carrying the detail over

/** What is written to the new version (`appStoreReviewDetails` attributes): only the values to set. */
export type ReviewMerge = {
  attributes: Record<string, string | boolean>;
  /** How many attributes are set (counts only: this is what logs and the audit keep). */
  fieldsCopied: number;
};

/**
 * What to write onto the version's detail so it holds what the source holds, WITHOUT overwriting anything the version already has:
 * a text that is blank on the target (null, empty, whitespace) and filled on the source is copied; a filled target text is never
 * touched. `demoAccountRequired` is copied only when the target does not say (null) or is an untouched default (false on a detail
 * with no text at all). The source's blank texts are never copied. `fieldsCopied` is 0 when there is nothing to write.
 */
export function mergeReviewDetail(target: ReviewDetail | null, source: ReviewDetail): ReviewMerge {
  const attributes: Record<string, string | boolean> = {};
  for (const field of REVIEW_TEXT_FIELDS) {
    const wanted = source.text[field];
    if (isBlankReviewValue(wanted)) continue;
    if (target && !isBlankReviewValue(target.text[field])) continue;
    attributes[field] = wanted as string;
  }
  if (source.demoAccountRequired !== null) {
    const untouched = !target || target.demoAccountRequired === null || (!reviewDetailHasContent(target) && target.demoAccountRequired === false);
    if (untouched && (!target || target.demoAccountRequired !== source.demoAccountRequired))
      attributes.demoAccountRequired = source.demoAccountRequired;
  }
  return { attributes, fieldsCopied: Object.keys(attributes).length };
}

/** A version of the store as the carry-over reads it. */
export type ReviewSourceCandidate = {
  id: string;
  versionString: string | null;
  state: string;
  editable: boolean;
};

const LIVE_STATES = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'];

/** The most versions whose detail is read to find a source. */
export const MAX_REVIEW_SOURCES = 4;

const rank = (v: ReviewSourceCandidate): number =>
  LIVE_STATES.indexOf(v.state) >= 0 ? 0 : v.editable ? 2 : 1;

/**
 * The versions to look at for a detail to carry over, best first: the live one (ready for distribution), then the other versions that
 * cannot be edited, then the editable ones (a rejected version), each group newest version first. The target itself is left out. At
 * most `MAX_REVIEW_SOURCES`.
 */
export function reviewSourceOrder(
  versions: readonly ReviewSourceCandidate[],
  targetId: string,
): ReviewSourceCandidate[] {
  const newer = (a: ReviewSourceCandidate, b: ReviewSourceCandidate): number => {
    const ad = a.versionString !== null && isDottedVersion(a.versionString);
    const bd = b.versionString !== null && isDottedVersion(b.versionString);
    if (ad && bd) return -(compareDottedVersions(a.versionString as string, b.versionString as string) as number);
    return ad === bd ? 0 : ad ? -1 : 1;
  };
  return versions
    .filter((v) => v.id !== targetId)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || newer(a.v, b.v) || a.i - b.i)
    .map((x) => x.v)
    .slice(0, MAX_REVIEW_SOURCES);
}

// ---------------------------------------------------------------------------------------------
// What a screen may show

/** The detail as a screen may show it: initials and yes/no. No name, phone number, email address, user name, password or note text. */
export type ReviewSummary = {
  /** "M. G." (the initials of the contact), null when the contact has no name. */
  contact: string | null;
  phone: boolean;
  email: boolean;
  demoAccount: 'not_required' | 'required' | 'unknown';
  demoCredentials: boolean;
  notes: boolean;
};

const initial = (value: string | null | undefined): string => {
  const first = Array.from((value ?? '').trim())[0];
  return first === undefined ? '' : `${first.toUpperCase()}.`;
};

export function maskedReviewSummary(detail: ReviewDetail): ReviewSummary {
  const initials = [initial(detail.text.contactFirstName), initial(detail.text.contactLastName)]
    .filter((s) => s !== '')
    .join(' ');
  return {
    contact: initials === '' ? null : initials,
    phone: !isBlankReviewValue(detail.text.contactPhone),
    email: !isBlankReviewValue(detail.text.contactEmail),
    demoAccount:
      detail.demoAccountRequired === true
        ? 'required'
        : detail.demoAccountRequired === false
          ? 'not_required'
          : 'unknown',
    demoCredentials:
      !isBlankReviewValue(detail.text.demoAccountName) &&
      !isBlankReviewValue(detail.text.demoAccountPassword),
    notes: !isBlankReviewValue(detail.text.notes),
  };
}
