import { isStageableTextField, type ListingStore, type Platform } from '@kiln/core';

/**
 * The words around an AI keyword idea and a suggested listing text, pure. A keyword idea names the listing field it would help most
 * ("title", "keyword field"): that is a SUGGESTION of where to put it, not something that was done. Accepting the idea only TRACKS the
 * keyword. Putting it in the listing is a separate, explicit action that STAGES the edited text (our own database); a push to a store
 * stays the gated step of the staged changes. Written for the ES2017 web build.
 */

/** The sentence every placement line is followed by. */
export const PLACEMENT_NOT_APPLIED =
  'This is a suggestion for what to put there. Nothing changes until you stage it.';

/** Said once above the ideas: what ticking and accepting does. */
export const TRACKING_ONLY_NOTE =
  'Accepting only tracks the keyword, so you can follow its rank. It does not change your listing. To use a keyword in your listing, stage it in a field below.';

/** The field in the words of the screen. The App Store name is the title of the app in the store. */
const LABELS: Record<string, string> = {
  name: 'Title (App Store name)',
  title: 'Title',
  subtitle: 'Subtitle',
  keywords: 'Keyword field',
  promotional_text: 'Promotional text',
  description: 'Description',
  short_description: 'Short description',
  full_description: 'Full description',
};

/** The label in a sentence ("keyword field", "title"). */
const LOWER: Record<string, string> = {
  name: 'title',
  title: 'title',
  subtitle: 'subtitle',
  keywords: 'keyword field',
  promotional_text: 'promotional text',
  description: 'description',
  short_description: 'short description',
  full_description: 'full description',
};

export const placementLabel = (field: string): string => LABELS[field] ?? field;
export const placementWord = (field: string): string => LOWER[field] ?? field;

/** "Where it would go: Title", or that it is for tracking only. */
export function placementLine(field: string | null): string {
  return field === null
    ? 'Where it would go: no listing field, tracking only'
    : `Where it would go: ${placementLabel(field)}`;
}

/** "Stage in title", "Stage in keyword field". */
export const stageInLabel = (field: string): string => `Stage in ${placementWord(field)}`;

/** The AI task and the store use these ids; `app_store` and `google_play` are the stores of a keyword proposal. */
export const platformOfStore = (store: ListingStore): Platform =>
  store === 'google_play' ? 'android' : 'ios';

/** A draft push can write the field of this store (the App Store name and subtitle are not written). */
export const canStagePlacement = (store: ListingStore, field: string): boolean =>
  isStageableTextField(platformOfStore(store), field);

/** What the button of a text proposal says: "Stage in keyword field" for one text, "Stage 2 texts" for more. */
export function stageTextsLabel(fields: readonly string[]): string {
  if (fields.length === 1) return stageInLabel(fields[0] as string);
  return `Stage ${fields.length} ${fields.length === 1 ? 'text' : 'texts'}`;
}
