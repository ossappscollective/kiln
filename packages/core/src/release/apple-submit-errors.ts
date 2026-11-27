import {
  fixKindOf,
  type ReadinessFixKind,
  type SubmitBlocker,
} from '../listing/draft-readiness.ts';

/**
 * Why Apple refused to send a version for review, as blockers (docs/state-model.md "Single owners (core)", docs/api/pending.md "Why a
 * publish failed"). Apple answers `409 STATE_ERROR.ENTITY_STATE_INVALID` ("This resource cannot be reviewed, please check associated
 * errors to see why") and lists the reasons in `errors[].meta.associatedErrors`, keyed by the resource (`/v1/appStoreReviewDetails/<id>`).
 * The connector keeps each as a reason (code, title, detail, pointer, resource kind). This ONE pure mapper turns the reasons into the
 * blocker shape the readiness uses (`SubmitBlocker`: code, sentence, where it is fixed), table driven: a reason that no rule knows is
 * shown as Apple said it, with its resource, never dropped. The same codes serve the compliance read after a refusal that listed none
 * (`appleComplianceBlockers`). Nothing here reads a store or a clock. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** One reason of Apple, as the connector keeps it (`StoreErrorDetail`). */
export type AppleReason = {
  code?: string | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  pointer?: string | undefined;
  /** The kind of resource (`ageRatingDeclarations`); set on the reasons that came from `associatedErrors`. */
  resource?: string | undefined;
};

/**
 * The codes this mapper owns, for the reasons the readiness had no check for. The others reuse the codes of the readiness
 * (`no_review_contact`, `no_review_demo_account`, `no_build`, `build_expired`, `build_not_valid`, `no_screenshots`, `already_submitted`):
 * one rule, one code, one fix text, whether Apple said it or the draft showed it.
 */
export const APPLE_SUBMIT_CODES = [
  'apple_age_rating',
  'apple_content_rights',
  'apple_export_compliance',
  'apple_privacy_policy',
  'apple_copyright',
  'apple_pricing',
  'apple_category',
  'apple_privacy_labels',
  'apple_reason',
] as const;
export type AppleSubmitCode = (typeof APPLE_SUBMIT_CODES)[number];

/** The App Store Connect page where a reason is fixed (the web shows it next to the how-to). */
export const APPLE_SUBMIT_PAGE: Readonly<Record<string, string>> = {
  no_review_contact: 'App Store > the version > App Review Information',
  no_review_demo_account: 'App Store > the version > App Review Information > Sign-in information',
  apple_age_rating: 'App Information > Age Rating',
  apple_content_rights: 'App Information > Content Rights',
  apple_export_compliance:
    'TestFlight > the build > Export Compliance (or the Info.plist key ITSAppUsesNonExemptEncryption)',
  no_build: 'App Store > the version > Build',
  build_expired: 'TestFlight > Builds',
  build_not_valid: 'TestFlight > Builds',
  no_screenshots: 'App Store > the version > Previews and Screenshots',
  apple_privacy_policy: 'App Information > Privacy Policy URL',
  apple_copyright: 'App Store > the version > Copyright',
  apple_pricing: 'Pricing and Availability',
  apple_category: 'App Information > Category',
  apple_privacy_labels: 'App Privacy',
  already_submitted: 'App Store > the version',
  apple_reason: 'App Store Connect',
};

export const isAppleSubmitCode = (code: string): code is AppleSubmitCode =>
  (APPLE_SUBMIT_CODES as readonly string[]).indexOf(code) >= 0;

/** The codes of this mapper that a fresh read of the store can judge again (`appleComplianceBlockers`): the readiness recomputes them. */
export const APPLE_RECOMPUTABLE_CODES: readonly string[] = [
  'apple_age_rating',
  'apple_content_rights',
  'apple_export_compliance',
  'apple_privacy_policy',
  'apple_category',
];

/** Where a code is fixed: the readiness's own kinds for its codes, App Store Connect for the codes of this mapper. */
export const appleSubmitFixKind = (code: string): ReadinessFixKind | undefined =>
  isAppleSubmitCode(code) ? 'store' : undefined;

type Rule = {
  code: string;
  /** English sentence of what is missing; `{fields}` is the list of the attributes Apple named. */
  message: string;
  /** The text of a reason (resource, code, pointer, title, detail) is tested against this. */
  match: (r: AppleReason, text: string, resource: string) => boolean;
  /** The attribute names to list (from the pointer or the sentence). */
  fields?: RegExp;
};

const ATTR = /attribute '([A-Za-z]+)'/;

/** The rules, first match wins: the more specific before the general. */
const RULES: readonly Rule[] = [
  {
    code: 'no_review_demo_account',
    message: 'The App Review sign-in information is incomplete ({fields}).',
    match: (_r, text) => /demoAccount/i.test(text),
    fields: /(demoAccount[A-Za-z]*)/g,
  },
  {
    code: 'no_review_contact',
    message: 'The App Review contact is incomplete ({fields}).',
    match: (_r, text, res) =>
      /contact(FirstName|LastName|Phone|Email)/i.test(text) ||
      (/appStoreReviewDetails/i.test(res) && !/demoAccount|notes/i.test(text)),
    fields: /(contact[A-Za-z]+)/g,
  },
  {
    code: 'apple_age_rating',
    message: 'The age rating questionnaire is not complete ({fields}).',
    match: (_r, text, res) => /ageRating/i.test(`${res} ${text}`),
    fields: /(?:attribute |attributes\/)'?([A-Za-z]+)/g,
  },
  {
    code: 'apple_content_rights',
    message: 'The content rights declaration is not set.',
    match: (_r, text) => /contentRights/i.test(text) || /content rights/i.test(text),
  },
  {
    code: 'apple_export_compliance',
    message: 'The build has no export compliance answer (encryption).',
    match: (_r, text) =>
      /usesNonExemptEncryption|encryption|export compliance|exportCompliance/i.test(text),
  },
  {
    code: 'no_build',
    message: 'The version has no build selected.',
    match: (_r, text, res) =>
      /^builds?$/i.test(res) &&
      /required|must (have|provide)|missing|no build|not (been )?(selected|attached)|REQUIRED/i.test(
        text,
      ),
  },
  {
    code: 'build_expired',
    message: 'The build has expired.',
    match: (_r, text, res) => /^builds?$/i.test(res) && /expired/i.test(text),
  },
  {
    code: 'build_not_valid',
    message: 'The build is not ready for review (still processing, invalid or expired).',
    match: (_r, text, res) =>
      /^builds?$/i.test(res) ||
      /\b(processing|expired|invalid binary|build is not)\b/i.test(text) ||
      /preReleaseVersions|buildBetaDetails/i.test(res),
  },
  {
    code: 'no_screenshots',
    message: 'A screenshot set is missing or incomplete.',
    match: (_r, text, res) =>
      /screenshot/i.test(`${res} ${text}`) || /appScreenshotSets/i.test(res),
  },
  {
    code: 'apple_privacy_policy',
    message: 'The privacy policy URL is missing.',
    match: (_r, text) => /privacyPolicy|privacy policy/i.test(text),
  },
  {
    code: 'apple_privacy_labels',
    message: 'The App Privacy answers (privacy nutrition labels) are not published.',
    match: (_r, text, res) =>
      /appDataUsage|privacy (nutrition|practices|questions)|app privacy/i.test(`${res} ${text}`),
  },
  {
    code: 'apple_copyright',
    message: 'The copyright is missing.',
    match: (_r, text) => /copyright/i.test(text),
  },
  {
    code: 'apple_pricing',
    message: 'The price or the availability is not set.',
    match: (_r, text, res) =>
      /appPrice|appAvailabilit|priceSchedule|territor/i.test(`${res} ${text}`) ||
      /\b(price|pricing|availability)\b/i.test(text),
  },
  {
    code: 'apple_category',
    message: 'The primary category is not set.',
    match: (_r, text) => /categor/i.test(text),
  },
  {
    code: 'already_submitted',
    message: 'The version is already in review or past it.',
    match: (_r, text) =>
      /already (been )?(submitted|in review)|WAITING_FOR_REVIEW|IN_REVIEW|READY_FOR_REVIEW|in a review submission/i.test(
        text,
      ),
  },
];

const clean = (s: string | undefined, max: number): string =>
  (s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The attribute names a reason is about (from the pointer `/data/attributes/contactEmail` and the sentence `attribute 'contactEmail'`). */
function fieldsOf(r: AppleReason, rule: Rule | undefined): string[] {
  const found: string[] = [];
  const add = (v: string | undefined) => {
    if (v && /^[A-Za-z][A-Za-z0-9]{1,60}$/.test(v) && found.indexOf(v) < 0) found.push(v);
  };
  const pointer = /attributes\/([A-Za-z0-9]+)/.exec(r.pointer ?? '');
  if (pointer) add(pointer[1]);
  const named = ATTR.exec(r.detail ?? '');
  if (named) add(named[1]);
  if (found.length === 0 && rule?.fields) {
    const re = new RegExp(rule.fields.source, 'g');
    const t = `${r.detail ?? ''} ${r.title ?? ''}`;
    let m = re.exec(t);
    while (m !== null) {
      add(m[1]);
      m = re.exec(t);
    }
  }
  return found;
}

const sentenceOf = (rule: Rule, fields: string[]): string => {
  const list = fields.join(', ');
  return rule.message
    .replace(/ \(\{fields\}\)/, list ? ` (${list})` : '')
    .replace('{fields}', list);
};

/** True for the reason that only says "check associated errors" (it names no resource: the reasons are the others). */
const isGeneric = (r: AppleReason): boolean =>
  r.resource === undefined && /ENTITY_STATE_INVALID|STATE_ERROR/.test(r.code ?? '');

/**
 * The blockers behind a refused submit, one per cause (reasons of one cause are merged and their attributes listed), each with its fix
 * kind. An empty answer means Apple listed no reason (the caller then reads the usual suspects: `appleComplianceBlockers`).
 * `hasReasons` tells whether any associated reason existed at all.
 */
export function explainAppleSubmitErrors(
  reasons: readonly AppleReason[],
  app: { id: string; platform: string } = { id: '', platform: 'ios' },
): SubmitBlocker[] {
  const out: SubmitBlocker[] = [];
  const byCode = new Map<string, SubmitBlocker>();
  const asked = reasons.filter((r) => !isGeneric(r));
  for (const r of asked) {
    const resource = r.resource ?? '';
    const text = [r.resource, r.code, r.pointer, r.title, r.detail].filter(Boolean).join(' ');
    const rule = RULES.find((x) => x.match(r, text, resource));
    const fields = fieldsOf(r, rule);
    if (rule === undefined) {
      const said = clean(r.detail ?? r.title ?? r.code, 240);
      if (said === '' && resource === '') continue;
      out.push(
        build(
          'apple_reason',
          `Apple: ${said || 'no sentence'}${resource ? ` (${resource})` : ''}.`,
          [],
          {
            ...(r.code ? { apple: clean(r.code, 80) } : {}),
            ...(resource ? { resource } : {}),
          },
          app,
        ),
      );
      continue;
    }
    const known = byCode.get(rule.code);
    if (known) {
      const merged = clean(
        `${(known.params?.fields as string | undefined) ?? ''},${fields.join(',')}`,
        200,
      )
        .split(/\s*,\s*/)
        .filter((v, i, a) => v !== '' && a.indexOf(v) === i);
      known.params = { ...(known.params ?? {}), fields: merged.join(', ') };
      known.message = sentenceOf(rule, merged);
      if (merged.length > 0) known.item = merged.join(', ');
      continue;
    }
    const made = build(
      rule.code,
      sentenceOf(rule, fields),
      fields,
      resource ? { resource } : {},
      app,
    );
    byCode.set(rule.code, made);
    out.push(made);
  }
  return out;
}

function build(
  code: string,
  message: string,
  fields: string[],
  extra: Record<string, string>,
  app: { id: string; platform: string },
): SubmitBlocker {
  const kind = isAppleSubmitCode(code) ? 'store' : fixKindOf(code);
  return {
    code,
    message,
    params: {
      ...extra,
      page: APPLE_SUBMIT_PAGE[code] ?? 'App Store Connect',
      ...(fields.length > 0 ? { fields: fields.join(', ') } : {}),
    },
    ...(fields.length > 0 ? { item: fields.join(', ') } : {}),
    fix: {
      kind,
      href:
        kind === 'build'
          ? `#/portfolio/${encodeURIComponent(app.id)}/releases?platform=${encodeURIComponent(app.platform)}&step=build`
          : kind === 'screenshots'
            ? `#/portfolio/${encodeURIComponent(app.id)}/listing?platform=${encodeURIComponent(app.platform)}&view=graphics`
            : null,
    },
  };
}

/** The facts of the read after a refusal that listed no reason (read-only; `null`: could not be read, so nothing is said about it). */
export type AppleComplianceFacts = {
  /** `apps.contentRightsDeclaration`: null while not set. */
  contentRightsDeclaration?: string | null | undefined;
  /** The age rating questions Apple has that are still null (empty: complete). Undefined: not read. */
  ageRatingMissing?: string[] | undefined;
  /** The build: its state, whether it expired and whether the export compliance question is answered. Undefined: no build or not read. */
  build?:
    | {
        processingState: string | null;
        expired: boolean | null;
        usesNonExemptEncryption: boolean | null;
      }
    | null
    | undefined;
  /** `appInfoLocalizations.privacyPolicyUrl` of each locale of the app info: a locale with none is listed. */
  privacyPolicyMissing?: string[] | undefined;
  /** `appInfos` primary category is set (false: missing). */
  primaryCategorySet?: boolean | undefined;
};

/** The blockers of the usual suspects Apple can reject a submit for, from facts read after the refusal. Pure; what was not read is not judged. */
export function appleComplianceBlockers(
  facts: AppleComplianceFacts,
  app: { id: string; platform: string } = { id: '', platform: 'ios' },
): SubmitBlocker[] {
  const reasons: AppleReason[] = [];
  if (facts.contentRightsDeclaration === null)
    reasons.push({
      resource: 'apps',
      code: 'READ',
      pointer: '/data/attributes/contentRightsDeclaration',
      detail: 'contentRightsDeclaration is not set',
    });
  if (facts.ageRatingMissing !== undefined && facts.ageRatingMissing.length > 0)
    for (const f of facts.ageRatingMissing)
      reasons.push({
        resource: 'ageRatingDeclarations',
        code: 'READ',
        pointer: `/data/attributes/${f}`,
        detail: `${f} is not answered`,
      });
  const b = facts.build;
  if (b) {
    if (b.expired === true || (b.processingState !== null && b.processingState !== 'VALID'))
      reasons.push({
        resource: 'builds',
        code: 'READ',
        detail: b.expired === true ? 'The build is expired' : `The build is ${b.processingState}`,
      });
    else if (b.usesNonExemptEncryption === null)
      reasons.push({
        resource: 'builds',
        code: 'READ',
        pointer: '/data/attributes/usesNonExemptEncryption',
        detail: 'usesNonExemptEncryption is not answered',
      });
  }
  if (facts.privacyPolicyMissing !== undefined && facts.privacyPolicyMissing.length > 0)
    reasons.push({
      resource: 'appInfoLocalizations',
      code: 'READ',
      pointer: '/data/attributes/privacyPolicyUrl',
      detail: 'The privacy policy URL is missing',
    });
  if (facts.primaryCategorySet === false)
    reasons.push({ resource: 'appInfos', code: 'READ', detail: 'The primary category is not set' });
  return explainAppleSubmitErrors(reasons, app);
}
