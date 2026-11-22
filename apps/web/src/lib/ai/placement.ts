import { isStageableTextField, type ListingStore, type Platform } from '@kiln/core';
import { k, t } from '../i18n/t.ts';

/**
 * The words around an AI keyword idea and a suggested listing text, pure. A keyword idea names the listing field it would help most
 * ("title", "keyword field"): that is a SUGGESTION of where to put it, not something that was done. Accepting the idea only TRACKS the
 * keyword. Putting it in the listing is a separate, explicit action that STAGES the edited text (our own database); a push to a store
 * stays the gated step of the staged changes. Written for the ES2017 web build.
 */

/** The key of the sentence every placement line is followed by (translate it with `t()` where it is drawn). */
export const PLACEMENT_NOT_APPLIED = k('ai:placement.notApplied');

/** The key of the note said once above the ideas: what ticking and accepting does. */
export const TRACKING_ONLY_NOTE = k('ai:placement.trackingOnly');

/** The field in the words of the screen. The App Store name is the title of the app in the store. */
const LABELS: Record<string, string> = {
  name: k('ai:field.name'),
  title: k('ai:field.title'),
  subtitle: k('ai:field.subtitle'),
  keywords: k('ai:field.keywords'),
  promotional_text: k('ai:field.promotionalText'),
  description: k('ai:field.description'),
  short_description: k('ai:field.shortDescription'),
  full_description: k('ai:field.fullDescription'),
};

/**
 * "Stage in title", "Stage in keyword field", "Draft in title" and "A draft push cannot write the title...": one whole message per field,
 * because the article and the preposition that go with the field name differ by language and by field.
 */
type FieldMessages = { stageIn: string; draftIn: string; draftCannot: string };
const BY_FIELD: Record<string, FieldMessages> = {
  name: { stageIn: k('ai:stageIn.title'), draftIn: k('ai:draftIn.title'), draftCannot: k('ai:draftCannot.title') },
  title: { stageIn: k('ai:stageIn.title'), draftIn: k('ai:draftIn.title'), draftCannot: k('ai:draftCannot.title') },
  subtitle: { stageIn: k('ai:stageIn.subtitle'), draftIn: k('ai:draftIn.subtitle'), draftCannot: k('ai:draftCannot.subtitle') },
  keywords: { stageIn: k('ai:stageIn.keywords'), draftIn: k('ai:draftIn.keywords'), draftCannot: k('ai:draftCannot.keywords') },
  promotional_text: {
    stageIn: k('ai:stageIn.promotionalText'),
    draftIn: k('ai:draftIn.promotionalText'),
    draftCannot: k('ai:draftCannot.promotionalText'),
  },
  description: {
    stageIn: k('ai:stageIn.description'),
    draftIn: k('ai:draftIn.description'),
    draftCannot: k('ai:draftCannot.description'),
  },
  short_description: {
    stageIn: k('ai:stageIn.shortDescription'),
    draftIn: k('ai:draftIn.shortDescription'),
    draftCannot: k('ai:draftCannot.shortDescription'),
  },
  full_description: {
    stageIn: k('ai:stageIn.fullDescription'),
    draftIn: k('ai:draftIn.fullDescription'),
    draftCannot: k('ai:draftCannot.fullDescription'),
  },
};

export const placementLabel = (field: string): string => {
  const key = LABELS[field];
  return key ? t(key) : field;
};

/** "Where it would go: Title", or that it is for tracking only. */
export function placementLine(field: string | null): string {
  return field === null
    ? t('ai:placement.whereNone')
    : t('ai:placement.where', { field: placementLabel(field) });
}

/** "Stage in title", "Stage in keyword field". */
export const stageInLabel = (field: string): string => {
  const m = BY_FIELD[field];
  return m ? t(m.stageIn) : t('ai:stageIn.other', { field });
};

/** "Draft in title": the button for a field a draft push cannot write. */
export const draftInLabel = (field: string): string => {
  const m = BY_FIELD[field];
  return m ? t(m.draftIn) : t('ai:draftIn.other', { field });
};

/** "A draft push cannot write the title on this store, so this stays a draft you copy." */
export const draftCannotText = (field: string): string => {
  const m = BY_FIELD[field];
  return m ? t(m.draftCannot) : t('ai:draftCannot.other', { field });
};

/** The AI task and the store use these ids; `app_store` and `google_play` are the stores of a keyword proposal. */
export const platformOfStore = (store: ListingStore): Platform =>
  store === 'google_play' ? 'android' : 'ios';

/** A draft push can write the field of this store (the App Store name and subtitle are not written). */
export const canStagePlacement = (store: ListingStore, field: string): boolean =>
  isStageableTextField(platformOfStore(store), field);

/** What the button of a text proposal says: "Stage in keyword field" for one text, "Stage 2 texts" for more. */
export function stageTextsLabel(fields: readonly string[]): string {
  if (fields.length === 1) return stageInLabel(fields[0] as string);
  return t('ai:accept.stageTexts', { count: fields.length });
}
