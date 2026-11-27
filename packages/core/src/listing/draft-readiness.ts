import { assetFact } from '../images/facts.ts';
import { checkTextField, textLimitOf } from '../listing-facts/text.ts';
import {
  APP_STORE_FIELD_SPECS,
  type ListingFieldSpec,
  type ListingStore,
  measureField,
  PLAY_CHANGELOG_SPEC,
  PLAY_FIELD_SPECS,
} from './listing.ts';
import { APPLE_VERSION_LOCALIZATION_ATTRIBUTES, PLAY_LISTING_MEMBERS } from './staged-changes.ts';
import { type AssetFacts, type AssetKind, validateAssets } from './store-asset-specs.ts';

/**
 * Whether a store listing DRAFT can be sent for review, judged from what the draft holds: one pure answer for every place that needs
 * it (docs/api/pending.md "Readiness", docs/state-model.md). The server runs it on the draft as the store reads it (a submit,
 * after a push) and on the draft a push WOULD leave (`predictDraft`, before anything is sent), the web reads the same findings from the
 * plan. Nothing here reads a store, a clock or a database; the limits come from the field and asset specs, never retyped.
 *
 * What it knows is what is written down in a draft: the text of each locale, the sets of graphics with their counts and pixel sizes.
 * What only the store knows once the push is made (an image still being processed, a draft somebody changed meanwhile, the state
 * of the version) is NOT guessed here: those checks stay with the submit itself (`evaluateChecks` in the server).
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** One image of a set: its pixel size when known (the store lists it; a staged file carries it). */
export type DraftImage = { width: number | null; height: number | null };

/** One set of graphics of a locale: the screenshots of one device size, or one Google Play graphic. */
export type DraftSet = {
  kind: AssetKind;
  /** A display id (`iphone_6_5`, `ipad_13`) or a Play device id (`phone`), null when it is not known. */
  device: string | null;
  /** The store's own name of the set (App Store placement group or display type, Google Play `AppImageType`). */
  target: string;
  images: DraftImage[];
};

/**
 * Where a locale of a draft comes from: `store` (the store's own draft holds it, even with no text) or `staged` (only the staged push
 * adds it). Nothing else makes a locale of the draft: not a folder of the repository, not another app.
 */
export type DraftLocaleOrigin = 'store' | 'staged';

export type DraftLocale = {
  locale: string;
  /** Where the locale comes from (absent: the store, which is what `draftContentOf` reads). */
  origin?: DraftLocaleOrigin | undefined;
  /** Listing field id -> the draft's value, null when not set. */
  text: Record<string, string | null>;
  assets: DraftSet[];
};

/** The content of a draft in the plain shape the rules read. */
export type DraftContent = {
  store: ListingStore;
  locales: DraftLocale[];
  /** The version the draft is of (App Store), to say which draft holds a locale. */
  version?: string | null | undefined;
  /** Google Play: the release notes of each language (they are not part of a listing locale), for the length rule. */
  releaseNotes?: { locale: string; text: string }[] | undefined;
};

export type ReadinessCode =
  | 'no_locales'
  | 'missing_text'
  /** A text over its limit, under its minimum or a URL that is none (`checkTextField`, the one text check). */
  | 'text_problem'
  | 'locale_without_screenshots'
  | 'no_screenshots'
  | 'asset_spec'
  | 'release_notes_too_long'
  /** App Store: the version's App Review contact (first and last name, phone, email) is missing or blank (`evaluateReviewInformation`). */
  | 'no_review_contact'
  /** App Store: a demo account is required by the review information and its user name or password is blank. */
  | 'no_review_demo_account';

export type ReadinessFinding = {
  code: ReadinessCode;
  /** `blocking`: the submit is refused until it is fixed. `warning`: shown, does not stop it. */
  severity: 'blocking' | 'warning';
  /** An English sentence (the web keeps it as the text of the finding and translates the advice next to it). */
  message: string;
  locale?: string;
  /** The field, set or file the finding is about. */
  item?: string;
  /** Set for a finding of `store-asset-specs` or of the listing field specs. */
  rule?: string;
  source?: string;
  verified?: boolean;
  /** The numbers and names of the sentence, for a translation. */
  params?: Record<string, string | number>;
};

/** `source` ('store_draft' | 'staged') and `version` of a locale's findings: a person can tell where a locale they did not expect comes from. */
const originParams = (content: DraftContent, locale: DraftLocale): Record<string, string> => ({
  source: locale.origin === 'staged' ? 'staged' : 'store_draft',
  ...(content.version ? { version: content.version } : {}),
});

const specsOf = (store: ListingStore): Record<string, ListingFieldSpec> =>
  (store === 'app_store' ? APP_STORE_FIELD_SPECS : PLAY_FIELD_SPECS) as Record<
    string,
    ListingFieldSpec
  >;

/** The text fields a locale of this store holds in a draft (a locale that is new has them all, empty). */
export const draftTextFields = (store: ListingStore): string[] =>
  Object.keys(store === 'app_store' ? APPLE_VERSION_LOCALIZATION_ATTRIBUTES : PLAY_LISTING_MEMBERS);

/**
 * The assets of a draft as the facts `validateAssets` reads (sizes only: the bytes of a store image are never read). Built by the one
 * facts builder (images/facts.ts): the same path as every other screen (`locale/kind/device#position`, the position counting on across
 * the sibling sets of one display) and the store's own set in `set`, so Apple's count is per set, not per display.
 */
export function assetFactsOf(content: DraftContent): AssetFacts[] {
  const out: AssetFacts[] = [];
  for (const locale of content.locales) {
    const placed = new Map<string, number>();
    for (const set of locale.assets) {
      const display = `${set.kind}:${set.device ?? ''}`;
      set.images.forEach((image) => {
        const position = (placed.get(display) ?? 0) + 1;
        placed.set(display, position);
        out.push(
          assetFact({
            store: content.store,
            locale: locale.locale,
            kind: set.kind,
            device: set.device,
            group: set.target,
            position,
            width: image.width,
            height: image.height,
          }),
        );
      });
    }
  }
  return out;
}

/** The number of screenshots a locale holds, all device sizes together. */
export const screenshotsOf = (locale: DraftLocale): number =>
  locale.assets.reduce((n, set) => (set.kind === 'screenshot' ? n + set.images.length : n), 0);

/**
 * The content rules of a draft, in the order a person reads them: no locale, then per locale (no screenshots of its own, an empty
 * required text, notes too long), then no screenshot anywhere, then the documented limits of the graphics (how many per device size,
 * which sizes and formats). Pure and total.
 */
export function evaluateDraftContent(content: DraftContent): ReadinessFinding[] {
  const out: ReadinessFinding[] = [];
  const specs = specsOf(content.store);
  if (content.locales.length === 0)
    out.push({
      code: 'no_locales',
      severity: 'blocking',
      message: 'The store listing has no locale.',
    });
  let screenshots = 0;
  for (const locale of content.locales) {
    const shots = screenshotsOf(locale);
    screenshots += shots;
    if (shots === 0)
      out.push({
        code: 'locale_without_screenshots',
        severity: 'warning',
        message: `${locale.locale} has no screenshots.`,
        locale: locale.locale,
      });
    for (const field of Object.keys(locale.text)) {
      const spec = specs[field];
      if (!spec) continue;
      // ONE text check (`checkTextField`): the same required, length and URL rules and the same severity as `validateListing`, the staged
      // view and the Insights checks. The keyword advice stays with the Insights checks.
      for (const problem of checkTextField(spec, locale.text[field], {
        locale: locale.locale,
        field,
      })) {
        const verified = problem.severity === 'error';
        if (problem.code === 'missing_required') {
          out.push({
            code: 'missing_text',
            severity: verified ? 'blocking' : 'warning',
            message: `${spec.label} is empty in ${locale.locale}.${verified ? '' : ' UNVERIFIED: no official page confirms it is required.'}`,
            locale: locale.locale,
            item: field,
            source: spec.source,
            verified,
            params: {
              field,
              label: spec.label,
              locale: locale.locale,
              ...originParams(content, locale),
            },
          });
        } else if (
          problem.code === 'too_long' ||
          problem.code === 'too_short' ||
          problem.code === 'invalid_url'
        ) {
          out.push({
            code: 'text_problem',
            severity: verified ? 'blocking' : 'warning',
            message: `${problem.message} (${locale.locale})`,
            locale: locale.locale,
            item: field,
            rule: `listing.${field}.${problem.code}`,
            source: spec.source,
            verified,
            params: {
              field,
              label: spec.label,
              locale: locale.locale,
              ...originParams(content, locale),
              problem: problem.code,
              ...(problem.limit !== undefined ? { limit: problem.limit } : {}),
              ...(problem.actual !== undefined ? { actual: problem.actual } : {}),
            },
          });
        }
      }
    }
  }
  if (content.store === 'google_play') {
    const limit = textLimitOf('google_play', 'release_notes');
    const max = limit?.max ?? null;
    for (const note of content.releaseNotes ?? []) {
      const count = measureField(PLAY_CHANGELOG_SPEC, note.text);
      if (max === null || count <= max) continue;
      const verified = limit?.maxVerified === true;
      out.push({
        code: 'release_notes_too_long',
        severity: verified ? 'blocking' : 'warning',
        message: `The release notes for ${note.locale} have ${count} characters. Google Play allows at most ${max} per language.`,
        locale: note.locale,
        item: 'release_notes',
        rule: 'play.release_notes.length',
        source: PLAY_CHANGELOG_SPEC.source,
        verified,
        params: { locale: note.locale, count, max },
      });
    }
  }
  if (content.locales.length > 0 && screenshots === 0)
    out.push({
      code: 'no_screenshots',
      severity: 'blocking',
      message: 'The listing has no screenshots in any locale.',
    });
  for (const p of validateAssets(content.store, assetFactsOf(content))) {
    if (p.severity === 'info') continue;
    out.push({
      code: 'asset_spec',
      severity: p.severity === 'error' && p.verified ? 'blocking' : 'warning',
      message: p.message,
      ...(p.locale !== undefined ? { locale: p.locale } : {}),
      item: p.path ?? (p.set ? `${p.rule}:${p.set}` : p.rule),
      rule: p.rule,
      source: p.source,
      verified: p.verified,
      // A count problem says which set is over (`set`: the store's name, `device`: the display) and by how much.
      ...(p.count !== undefined && p.max !== undefined
        ? {
            params: {
              count: p.count,
              max: p.max,
              ...(p.device ? { device: p.device } : {}),
              ...(p.set ? { set: p.set } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What a push would leave

/** One staged set: the files the store's set holds after the push (a push makes the set exactly these files). Empty: the set is cleared. */
export type StagedDraftSet = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  /** The store's name of the set when the plan knows it (a placement group), else the display type or image type. */
  target: string;
  /** App Store: the placement group the set is written to, when known. It is what the store lists the set under. */
  group?: string | null | undefined;
  images: DraftImage[];
};

/** What is staged for a push, in the plain shape (the server builds it from the push preview). */
export type StagedDraftChanges = {
  texts: { locale: string; field: string; value: string | null }[];
  sets: StagedDraftSet[];
  /** Google Play: the staged release notes (language, text). */
  releaseNotes?: { locale: string; value: string | null }[] | undefined;
};

const sameSet = (set: DraftSet, staged: StagedDraftSet): boolean =>
  (staged.group !== null && staged.group !== undefined && set.target === staged.group) ||
  set.target === staged.target ||
  (set.kind === staged.kind && set.device !== null && set.device === staged.device) ||
  (set.kind === staged.kind && staged.device === null && set.device === null);

/**
 * The draft as it would stand AFTER the staged push: the current content of the store's draft (every locale, every field and set the
 * store holds) with the staged texts written over it, the staged sets replacing the set they name (same locale, same group or device
 * size), a cleared set removed, and a locale the store does not have yet created, with every text field it would hold empty except
 * the staged ones. Everything else is kept as it is. Never mutates its input.
 *
 * It is a prediction of what is written, not a read of what the store will hold: it cannot know what the store does on its own
 * (a locale it fills from the default one, an image it drops for being unreadable). A new locale is the case that needs care: the
 * store creates it with the staged fields only, so every other required text of it is empty (a blocker the person sees now).
 */
export function predictDraft(current: DraftContent, staged: StagedDraftChanges): DraftContent {
  const fields = draftTextFields(current.store);
  const locales: DraftLocale[] = current.locales.map((l) => ({
    locale: l.locale,
    origin: l.origin ?? 'store',
    text: { ...l.text },
    assets: l.assets.map((s) => ({ ...s, images: s.images.slice() })),
  }));
  const ensure = (code: string): DraftLocale => {
    const found = locales.filter((l) => l.locale === code)[0];
    if (found) return found;
    const text: Record<string, string | null> = {};
    for (const field of fields) text[field] = null;
    const made: DraftLocale = { locale: code, origin: 'staged', text, assets: [] };
    locales.push(made);
    return made;
  };
  for (const t of staged.texts) {
    if (fields.indexOf(t.field) < 0) continue;
    ensure(t.locale).text[t.field] = t.value;
  }
  for (const s of staged.sets) {
    const locale = ensure(s.locale);
    let at = locale.assets.findIndex((set) => sameSet(set, s));
    // A push makes the set of a display exactly the staged files, in whatever placement group it sits: a sibling set that shows the same
    // display (the 12.9" group next to the 13" one) is removed with it, so it is not counted on top of the pushed set.
    const kept = at >= 0 ? (locale.assets[at] as DraftSet) : undefined;
    const display = s.device ?? kept?.device ?? null;
    if (display !== null) {
      for (let i = locale.assets.length - 1; i >= 0; i--) {
        const other = locale.assets[i] as DraftSet;
        if (i !== at && other.kind === s.kind && other.device === display) {
          locale.assets.splice(i, 1);
          if (i < at) at--;
        }
      }
    }
    if (s.images.length === 0) {
      if (at >= 0) locale.assets.splice(at, 1);
      continue;
    }
    const next: DraftSet = {
      kind: s.kind,
      device: s.device ?? kept?.device ?? null,
      target: kept ? kept.target : (s.group ?? s.target),
      images: s.images.slice(),
    };
    if (at >= 0) locale.assets[at] = next;
    else locale.assets.push(next);
  }
  // The notes of a language: the staged one replaces the one the draft has; an empty one clears it.
  const notes = (current.releaseNotes ?? []).slice();
  for (const n of staged.releaseNotes ?? []) {
    const at = notes.findIndex((x) => x.locale === n.locale);
    if (n.value === null || n.value.trim() === '') {
      if (at >= 0) notes.splice(at, 1);
    } else if (at >= 0) notes[at] = { locale: n.locale, text: n.value };
    else notes.push({ locale: n.locale, text: n.value });
  }
  return { store: current.store, version: current.version, locales, releaseNotes: notes };
}

// ---------------------------------------------------------------------------------------------
// The answer a person reads: what blocks a submit, and where it is fixed

/** Where a blocker is fixed: a screen of Kiln (`href` is its web address), the store's own console (`href` null: the web names the page), or a push. */
export type ReadinessFixKind =
  | 'listing'
  | 'screenshots'
  | 'notes'
  | 'build'
  | 'store'
  | 'push'
  /** The version's App Review Information: copied from the previous version in Kiln, or filled in App Store Connect (`href` null). */
  | 'review';
export type ReadinessFix = { kind: ReadinessFixKind; href: string | null };

export type SubmitBlocker = {
  code: string;
  message: string;
  params?: Record<string, string | number> | undefined;
  locale?: string | undefined;
  item?: string | undefined;
  fix: ReadinessFix;
};

/**
 * Whether the store's draft would be ready to submit once the staged push is made. `blockers` are certain (the push cannot change them or
 * makes them); `unknown` are the codes that only the store knows after the push (an image still being processed). `ready` is false
 * while a blocker stands; it says nothing about `unknown`.
 */
export type SubmitReadiness = {
  ready: boolean;
  blockers: SubmitBlocker[];
  unknown: string[];
};

const STORE_CODES = ['already_submitted', 'no_version', 'release_not_manual'];
const BUILD_CODES = ['no_build', 'build_expired', 'build_not_valid'];
/** The checks of the App Review Information (`evaluateReviewInformation`). */
export const REVIEW_CODES: readonly string[] = ['no_review_contact', 'no_review_demo_account'];

/** Which kind of fix a check code needs. An unknown code is a push (the draft is written again and read again). */
export function fixKindOf(code: string): ReadinessFixKind {
  if (code === 'missing_text' || code === 'text_problem' || code === 'no_locales') return 'listing';
  if (code === 'no_screenshots' || code === 'asset_spec') return 'screenshots';
  if (code === 'release_notes_too_long') return 'notes';
  if (BUILD_CODES.indexOf(code) >= 0) return 'build';
  if (REVIEW_CODES.indexOf(code) >= 0) return 'review';
  if (STORE_CODES.indexOf(code) >= 0) return 'store';
  return 'push';
}

const enc = encodeURIComponent;

/** The web address of the place a blocker is fixed (`#/portfolio/<app>/listing?platform=ios&view=text&locale=fr-FR`); null for the store's own pages and for a push. */
export function fixHref(
  app: { id: string; platform: string },
  kind: ReadinessFixKind,
  locale?: string,
): string | null {
  const base = `#/portfolio/${enc(app.id)}`;
  const query = (extra: string[]) =>
    `?${[`platform=${enc(app.platform)}`].concat(extra).join('&')}`;
  const where = locale === undefined ? [] : [`locale=${enc(locale)}`];
  if (kind === 'listing') return `${base}/listing${query(['view=text'].concat(where))}`;
  if (kind === 'screenshots') return `${base}/listing${query(['view=graphics'].concat(where))}`;
  if (kind === 'notes') return `${base}/releases${query(['step=notes'])}`;
  if (kind === 'build') return `${base}/releases${query(['step=build'])}`;
  return null;
}

/** The blockers of a list of findings (the blocking ones), each with its fix. Pure. */
export function blockersOf(
  app: { id: string; platform: string },
  findings: readonly {
    code: string;
    severity: 'blocking' | 'warning';
    message: string;
    locale?: string | undefined;
    item?: string | undefined;
    params?: Record<string, string | number> | undefined;
  }[],
): SubmitBlocker[] {
  const out: SubmitBlocker[] = [];
  for (const f of findings) {
    if (f.severity !== 'blocking') continue;
    const kind = fixKindOf(f.code);
    out.push({
      code: f.code,
      message: f.message,
      ...(f.params !== undefined ? { params: f.params } : {}),
      ...(f.locale !== undefined ? { locale: f.locale } : {}),
      ...(f.item !== undefined ? { item: f.item } : {}),
      fix: { kind, href: fixHref(app, kind, f.locale) },
    });
  }
  return out;
}

/** The codes that only the store knows once the push is made (nothing here is guessed): what a person is told is checked after the push. */
export const AFTER_PUSH_CODES: readonly string[] = ['image_not_ready', 'draft_differs'];

/** Assembles the answer from the blockers and the unknown codes. */
export const readinessOf = (blockers: SubmitBlocker[], unknown: string[]): SubmitReadiness => ({
  ready: blockers.length === 0,
  blockers,
  unknown,
});

// ---------------------------------------------------------------------------------------------
// A blocker is a claim about one moment

/** What names a blocker for comparing two moments: the check, the locale and the field or rule it is about (a set's name is left out). */
type BlockerRef = {
  code: string;
  locale?: string | undefined;
  item?: string | undefined;
};

/** The identity of a blocker across two readings of the store (`apple.screenshot.count:APP_IPAD_PRO_129` and `apple.screenshot.count` are one). */
export const blockerKey = (b: BlockerRef): string =>
  `${b.code}|${b.locale ?? ''}|${(b.item ?? '').split(':')[0]}`;

/**
 * What a run (or any earlier reading) said stood in the way of a submit, held against what stands in the way NOW. A blocker is only
 * true at the moment it was computed: `resolved` are the ones of the earlier reading that no longer hold, `remaining` is the current
 * list (what to show), `added` the current blockers the earlier reading did not have. Pure.
 */
export function reconcileBlockers<R extends BlockerRef, C extends BlockerRef>(
  earlier: readonly R[],
  current: readonly C[],
): { remaining: C[]; resolved: R[]; added: C[] } {
  const now = new Set(current.map(blockerKey));
  const before = new Set(earlier.map(blockerKey));
  return {
    remaining: current.slice(),
    resolved: earlier.filter((b) => !now.has(blockerKey(b))),
    added: current.filter((b) => !before.has(blockerKey(b))),
  };
}

/**
 * The codes a fresh read of the store can judge (everything `submitReadinessOf` evaluates). A blocker of an earlier run with another code
 * (`draft_differs`, `image_not_ready`, `push_in_progress`...) was a fact of that moment's push that nothing can recompute; the submit
 * itself checks it again, so it is never carried over as current.
 */
export const RECOMPUTABLE_CODES: readonly string[] = [
  'no_locales',
  'missing_text',
  'text_problem',
  'locale_without_screenshots',
  'no_screenshots',
  'asset_spec',
  'release_notes_too_long',
  'no_review_contact',
  'no_review_demo_account',
  'already_submitted',
  'no_version',
  'release_not_manual',
  'no_build',
  'build_expired',
  'build_not_valid',
];
