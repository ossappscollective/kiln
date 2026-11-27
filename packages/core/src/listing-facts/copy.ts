import { DEFAULT_LOCALE_FOLDER, localeGroupKey, localeKey } from './locale.ts';

/**
 * THE store copy of a listing: which channel a consumer reads, said ONCE (docs/state-model.md, "Single owners (core)"). A store holds two
 * copies of the listing: the LIVE one users see and the EDITABLE one (the App Store version in preparation, a draft). Seven consumers each
 * picked between them by hand: the Listing grid (live if ANY live row, else editable, per locale), Insights listing checks (live only, so a
 * locale only the draft has was missing from the card), ASO fit/keywords/terms (live with locales else any), listing fixes (live then
 * editable), the asset proposal (editable first), pull (live else editable), the release stepper (editable else the first channel). Five
 * pages, five locale lists.
 *
 * THE THREE INTENTS (`storeCopyView(channels, { intent })`):
 *  - `shown`    what a person LOOKS AT as "the store listing": the union of both copies' locales; each locale from the LIVE copy when it
 *               has it, else from the editable one. A locale only the draft has is there. For: the Listing page grid, Insights listing
 *               checks, ASO fit / keywords / terms, "pull to the repository".
 *  - `editable` the copy a PUSH writes into and a baseline is judged against: the editable copy's locales and texts; when the store has no
 *               editable copy at all (Google Play, an App Store app with no draft) the live copy stands in, because a push starts a draft
 *               from it. For: the staged-text baseline (`isUnchangedStaged`), the cart/pending `before`, listing fixes, the asset
 *               proposal's text plan, the release stepper's notes locales and the notes history, readiness, the publish summary's language.
 *  - `live`     what is IN USERS' HANDS: only the live copy; a locale only the draft has is absent. No fallback. For: the drift "on the
 *               store" column and every sentence that says "currently live".
 * A locale is read from ONE copy (`from`); `held` says which copies have it, so a screen can say "only in the draft".
 *
 * Locales are matched by key, then by the store equivalence table (an App Store `zh-Hans` and a Play `zh-CN` are one locale). Empty
 * localizations are kept (a locale the store holds with nothing set is listed with no fields): `locales` of a channel may map to `{}`.
 * The `default` fallback folder is not a locale and never appears.
 *
 * Pure. ES2017.
 */

export type CopyChannelName = 'live' | 'editable';

/** One channel of the stored listing (`LiveChannel` of the server): the texts per locale and field as last read. */
export type CopyChannel = {
  channel: CopyChannelName;
  locales: Readonly<Record<string, Readonly<Record<string, string>>>>;
  observedAt?: number | null | undefined;
  /** The store version the values were read from (App Store), when known. */
  sourceRef?: string | null | undefined;
};

export type CopyIntent = 'shown' | 'editable' | 'live';

/** Which consumer uses which intent. Data, so a test (and the docs table) can pin it; a consumer not listed asks before it picks one. */
export const COPY_INTENT_CONSUMERS: Readonly<Record<CopyIntent, readonly string[]>> = {
  shown: ['listing-grid', 'insights-listing-checks', 'aso-fit', 'aso-keywords', 'aso-terms', 'pull-to-repository'],
  editable: [
    'staged-baseline',
    'cart-before',
    'listing-fixes',
    'asset-proposal-text',
    'release-stepper-notes',
    'notes-history',
    'readiness',
    'publish-summary-language',
  ],
  live: ['drift-store-column', 'on-the-store-sentences'],
};

export type LocaleCopy = {
  locale: string;
  /** The copy the fields were read from. */
  from: CopyChannelName;
  /** Which copies hold this locale. */
  held: CopyChannelName[];
  fields: Record<string, string>;
};

export type StoreCopyView = {
  intent: CopyIntent;
  /** Sorted by locale. */
  locales: LocaleCopy[];
  /** The locale codes of `locales`. */
  codes: string[];
  /** Which copies the store has at all. */
  channels: { live: boolean; editable: boolean };
};

const channelOf = (
  channels: readonly CopyChannel[],
  name: CopyChannelName,
): CopyChannel | undefined => channels.filter((c) => c.channel === name)[0];

/** The locales of a channel without the `default` fallback, as `[code, fields]`. */
const entriesOf = (c: CopyChannel | undefined): [string, Record<string, string>][] =>
  c === undefined
    ? []
    : Object.keys(c.locales)
        .filter((code) => code !== DEFAULT_LOCALE_FOLDER)
        .map((code) => [code, { ...(c.locales[code] ?? {}) }]);

/** The listing's store copy for a consumer's intent (see the file comment). Never mutates its input. */
export function storeCopyView(
  channels: readonly CopyChannel[],
  options: { intent: CopyIntent },
): StoreCopyView {
  const live = channelOf(channels, 'live');
  const editable = channelOf(channels, 'editable');
  const intent = options.intent;
  const held = new Map<string, CopyChannelName[]>();
  const hold = (key: string, name: CopyChannelName) => {
    const list = held.get(key) ?? [];
    if (list.indexOf(name) < 0) list.push(name);
    held.set(key, list);
  };
  for (const [code] of entriesOf(live)) hold(localeGroupKey(code), 'live');
  for (const [code] of entriesOf(editable)) hold(localeGroupKey(code), 'editable');

  const rows = new Map<string, LocaleCopy>();
  const add = (code: string, fields: Record<string, string>, from: CopyChannelName) => {
    const key = localeGroupKey(code);
    if (rows.has(key)) return;
    rows.set(key, { locale: code, from, held: (held.get(key) ?? [from]).slice(), fields });
  };
  const order: CopyChannelName[] =
    intent === 'live'
      ? ['live']
      : intent === 'editable'
        ? editable !== undefined
          ? ['editable']
          : ['live']
        : ['live', 'editable'];
  for (const name of order) {
    const channel = name === 'live' ? live : editable;
    for (const [code, fields] of entriesOf(channel)) add(code, fields, name);
  }
  const locales = Array.from(rows.values()).sort((a, b) =>
    localeKey(a.locale) < localeKey(b.locale) ? -1 : localeKey(a.locale) > localeKey(b.locale) ? 1 : 0,
  );
  return {
    intent,
    locales,
    codes: locales.map((l) => l.locale),
    channels: { live: live !== undefined, editable: editable !== undefined },
  };
}

/** The copy of a locale (matched by key, then by the store equivalence table), or undefined. */
export function pickCopy(view: StoreCopyView, locale: string): LocaleCopy | undefined {
  const key = localeKey(locale);
  const exact = view.locales.filter((l) => localeKey(l.locale) === key)[0];
  if (exact !== undefined) return exact;
  const group = localeGroupKey(locale);
  return view.locales.filter((l) => localeGroupKey(l.locale) === group)[0];
}

/** The text of one field of a locale in this view, or null (no such locale, or no such field). */
export function copyText(view: StoreCopyView, locale: string, field: string): string | null {
  const copy = pickCopy(view, locale);
  if (copy === undefined) return null;
  const value = copy.fields[field];
  return value === undefined ? null : value;
}
