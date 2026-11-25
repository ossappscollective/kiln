import type { CoachAction, CoreText } from '@kiln/core';
import type { Params } from './i18n/core.ts';
import { formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

/**
 * English text that `@kiln/core` builds (rollout comparison and rules, keyword checks, the ASO coach) comes with a
 * stable key and parameters (`CoreText`). This module turns that into the active language with the `core` catalogs
 * (`locales/core`). The English text stays the fallback: a key this map does not know (a newer server) shows the
 * English sentence as it came. Keys are literals here so `pnpm i18n:check` sees them (docs/i18n.md, rule 10).
 */

const KEYS: Readonly<Record<string, string>> = {
  'aso.term.control': k('core:aso.term.control'),
  'aso.term.empty': k('core:aso.term.empty'),
  'aso.term.noLetter': k('core:aso.term.noLetter'),
  'aso.term.notText': k('core:aso.term.notText'),
  'aso.term.tooLong': k('core:aso.term.tooLong'),
  'aso.term.tooManyWords': k('core:aso.term.tooManyWords'),
  'coach.checkRanksFirst.detail': k('core:coach.checkRanksFirst.detail'),
  'coach.checkRanksFirst.title': k('core:coach.checkRanksFirst.title'),
  'coach.checkRanksStale.detail': k('core:coach.checkRanksStale.detail'),
  'coach.checkRanksStale.title': k('core:coach.checkRanksStale.title'),
  'coach.competitorAbove.detail': k('core:coach.competitorAbove.detail'),
  'coach.competitorAbove.itemRanked': k('core:coach.competitorAbove.itemRanked'),
  'coach.competitorAbove.itemUnranked': k('core:coach.competitorAbove.itemUnranked'),
  'coach.competitorAbove.title': k('core:coach.competitorAbove.title'),
  'coach.followCompetitors.detail': k('core:coach.followCompetitors.detail'),
  'coach.followCompetitors.title': k('core:coach.followCompetitors.title'),
  'coach.item.keywordLocale': k('core:coach.item.keywordLocale'),
  'coach.keywordFieldWaste.detail': k('core:coach.keywordFieldWaste.detail'),
  'coach.keywordFieldWaste.item': k('core:coach.keywordFieldWaste.item'),
  'coach.keywordFieldWaste.title': k('core:coach.keywordFieldWaste.title'),
  'coach.link.competitors': k('core:coach.link.competitors'),
  'coach.link.keywords': k('core:coach.link.keywords'),
  'coach.link.keywordsAdd': k('core:coach.link.keywordsAdd'),
  'coach.link.listing': k('core:coach.link.listing'),
  'coach.link.listingKeywords': k('core:coach.link.listingKeywords'),
  'coach.link.listingLocale': k('core:coach.link.listingLocale'),
  'coach.notInListing.detailApple': k('core:coach.notInListing.detailApple'),
  'coach.notInListing.detailPlay': k('core:coach.notInListing.detailPlay'),
  'coach.notInListing.title': k('core:coach.notInListing.title'),
  'coach.rankDropped.detail': k('core:coach.rankDropped.detail'),
  'coach.rankDropped.left': k('core:coach.rankDropped.left'),
  'coach.rankDropped.moved': k('core:coach.rankDropped.moved'),
  'coach.rankDropped.title': k('core:coach.rankDropped.title'),
  'coach.trackKeywords.detail': k('core:coach.trackKeywords.detail'),
  'coach.trackKeywords.title': k('core:coach.trackKeywords.title'),
  'coach.untappedLocale.detail': k('core:coach.untappedLocale.detail'),
  'coach.untappedLocale.itemEmptyKeywordField': k(
    'core:coach.untappedLocale.itemEmptyKeywordField',
  ),
  'coach.untappedLocale.itemEmptyKeywordFieldMarkets': k(
    'core:coach.untappedLocale.itemEmptyKeywordFieldMarkets',
  ),
  'coach.untappedLocale.itemEmptyShortDescription': k(
    'core:coach.untappedLocale.itemEmptyShortDescription',
  ),
  'coach.untappedLocale.itemEmptyShortDescriptionMarkets': k(
    'core:coach.untappedLocale.itemEmptyShortDescriptionMarkets',
  ),
  'coach.untappedLocale.itemNoLocale': k('core:coach.untappedLocale.itemNoLocale'),
  'coach.untappedLocale.itemNoLocaleMarkets': k('core:coach.untappedLocale.itemNoLocaleMarkets'),
  'coach.untappedLocale.titleApple': k('core:coach.untappedLocale.titleApple'),
  'coach.untappedLocale.titlePlay': k('core:coach.untappedLocale.titlePlay'),
  'coach.untrackedSet.detail': k('core:coach.untrackedSet.detail'),
  'coach.untrackedSet.item': k('core:coach.untrackedSet.item'),
  'coach.untrackedSet.itemMore': k('core:coach.untrackedSet.itemMore'),
  'coach.untrackedSet.title': k('core:coach.untrackedSet.title'),
  'coach.unusedCharacters.detail': k('core:coach.unusedCharacters.detail'),
  'coach.unusedCharacters.itemBytes': k('core:coach.unusedCharacters.itemBytes'),
  'coach.unusedCharacters.itemCharacters': k('core:coach.unusedCharacters.itemCharacters'),
  'coach.unusedCharacters.title': k('core:coach.unusedCharacters.title'),
  'play.check.codeAlreadyLive': k('core:play.check.codeAlreadyLive'),
  'play.check.codeInvalid': k('core:play.check.codeInvalid'),
  'play.check.codeNotNewer': k('core:play.check.codeNotNewer'),
  'play.check.codesMissing': k('core:play.check.codesMissing'),
  'play.check.fractionOutOfRange': k('core:play.check.fractionOutOfRange'),
  'play.check.fullRollout': k('core:play.check.fullRollout'),
  'play.check.nameEmpty': k('core:play.check.nameEmpty'),
  'play.check.notesMissing': k('core:play.check.notesMissing'),
  'play.check.notesNone': k('core:play.check.notesNone'),
  'play.check.notesOverLimit': k('core:play.check.notesOverLimit'),
  'play.check.trackMissing': k('core:play.check.trackMissing'),
  'play.fractionRefused': k('core:play.fractionRefused'),
  'play.offer.firstRelease': k('core:play.offer.firstRelease'),
  'play.offer.never': k('core:play.offer.never'),
  'rollout.action.doneCannotSkip': k('core:rollout.action.doneCannotSkip'),
  'rollout.action.earlierOpen': k('core:rollout.action.earlierOpen'),
  'rollout.action.laterDone': k('core:rollout.action.laterDone'),
  'rollout.action.notFound': k('core:rollout.action.notFound'),
  'rollout.appleNote': k('core:rollout.appleNote'),
  'rollout.compare.match': k('core:rollout.compare.match'),
  'rollout.compare.storeAhead': k('core:rollout.compare.storeAhead'),
  'rollout.compare.storeBehind': k('core:rollout.compare.storeBehind'),
  'rollout.compare.unknownApple': k('core:rollout.compare.unknownApple'),
  'rollout.compare.unknownNone': k('core:rollout.compare.unknownNone'),
  'rollout.compare.unknownStore': k('core:rollout.compare.unknownStore'),
  'rollout.issue.afterCreated': k('core:rollout.issue.afterCreated'),
  'rollout.issue.afterPrevious': k('core:rollout.issue.afterPrevious'),
  'rollout.issue.beforeDone': k('core:rollout.issue.beforeDone'),
  'rollout.issue.dateTime': k('core:rollout.issue.dateTime'),
  'rollout.issue.dayOneBeforeCreated': k('core:rollout.issue.dayOneBeforeCreated'),
  'rollout.issue.doneCannotRemove': k('core:rollout.issue.doneCannotRemove'),
  'rollout.issue.doneKeepsPercent': k('core:rollout.issue.doneKeepsPercent'),
  'rollout.issue.higherThanBefore': k('core:rollout.issue.higherThanBefore'),
  'rollout.issue.listedTwice': k('core:rollout.issue.listedTwice'),
  'rollout.issue.needStep': k('core:rollout.issue.needStep'),
  'rollout.issue.noteLength': k('core:rollout.issue.noteLength'),
  'rollout.issue.tooMany': k('core:rollout.issue.tooMany'),
  'rollout.issue.unknownStep': k('core:rollout.issue.unknownStep'),
  'rollout.issue.wholeNumber': k('core:rollout.issue.wholeNumber'),
  'rollout.template.applePhased.description': k('core:rollout.template.applePhased.description'),
  'rollout.template.applePhased.name': k('core:rollout.template.applePhased.name'),
  'rollout.template.immediate.description': k('core:rollout.template.immediate.description'),
  'rollout.template.immediate.name': k('core:rollout.template.immediate.name'),
  'rollout.template.playDefault.description': k('core:rollout.template.playDefault.description'),
  'rollout.template.playDefault.name': k('core:rollout.template.playDefault.name'),
};

/** A share written as 20 or 12.5 (percent units), in the active language: "20%", "20 %". */
export const sharePercent = (percent: number): string =>
  formatPercent(percent / 100, { maximumFractionDigits: 1 });

/** True when the web has a message for this key. */
export const knowsCoreText = (text: CoreText | undefined | null): boolean =>
  text !== undefined && text !== null && Object.hasOwn(KEYS, text.key);

/**
 * The sentence of a `CoreText` in the active language, or `fallback` (the English text) for a key that is not known.
 * A parameter named `percent` or ending in `Percent` is a share in percent units and is formatted for the language;
 * `overrides` replace parameters (the caller translates a word the key only names).
 */
export function coreMessage(
  text: CoreText | undefined | null,
  fallback: string,
  overrides: Params = {},
): string {
  if (!text || !knowsCoreText(text)) return fallback;
  const params: Record<string, string | number | boolean | null | undefined> = {};
  for (const name of Object.keys(text.params)) {
    const value = text.params[name] as string | number;
    params[name] =
      typeof value === 'number' && (name === 'percent' || name.endsWith('Percent'))
        ? sharePercent(value)
        : value;
  }
  const key = KEYS[text.key] ?? '';
  return t(key, { ...params, ...overrides });
}

// ---------------------------------------------------------------------------------------------
// The store against the plan

type ComparisonLike = {
  message: string;
  text?: CoreText | undefined;
};

/** The sentence under the store and plan figures of a rollout (`RolloutComparison.text`). */
export function rolloutComparisonMessage(comparison: ComparisonLike): string {
  const text = comparison.text;
  if (!text || !knowsCoreText(text)) return comparison.message;
  const p = text.params;
  const tail: string[] = [];
  if (p.halted === 1) tail.push(t('core:rollout.compare.halted'));
  if (p.canConfirm === 1) tail.unshift(t('core:rollout.compare.canConfirm'));
  const said =
    p.inferred === 1
      ? t('core:rollout.compare.saidInferred', { percent: sharePercent(Number(p.storePercent)) })
      : t('core:rollout.compare.said', { percent: sharePercent(Number(p.storePercent)) });
  const plan =
    Number(p.planIndex) > 0
      ? t('core:rollout.compare.planStep', {
          index: Number(p.planIndex),
          total: Number(p.planTotal),
          percent: sharePercent(Number(p.planPercent)),
        })
      : t('core:rollout.compare.planNone');
  return coreMessage(text, comparison.message, { said, plan, tail: tail.join(' ') }).trim();
}

/** The reason a keyword was refused (`checkTerm`). */
export const termReason = (check: { reason: string; text?: CoreText | undefined }): string =>
  coreMessage(check.text, check.reason);

/** A rule of the rollout plan that a list of steps broke (`validateRolloutSteps`). */
export const rolloutIssueMessage = (issue: {
  message: string;
  text?: CoreText | undefined;
}): string => coreMessage(issue.text, issue.message);

/** A built-in rollout template's name and description (`RolloutTemplate`). */
export const templateName = (template: { name: string; nameText?: CoreText | undefined }): string =>
  coreMessage(template.nameText, template.name);
export const templateDescription = (template: {
  description: string;
  descriptionText?: CoreText | undefined;
}): string => coreMessage(template.descriptionText, template.description);

/** A local check of a Google Play release (`checkPlayProposal`). */
export const playCheckMessage = (check: { message: string; text?: CoreText | undefined }): string =>
  coreMessage(check.text, check.message);

/** Why no staged rollout is offered (`rolloutOffer`): its `reason` is the stable code, the English message the fallback. */
export function rolloutOfferMessage(offer: {
  reason: string | null;
  message: string | null;
}): string {
  if (offer.reason === 'never') return t('core:play.offer.never');
  if (offer.reason === 'first_release') return t('core:play.offer.firstRelease');
  return offer.message ?? '';
}

// ---------------------------------------------------------------------------------------------
// The ASO coach

type CoachTexts = Pick<
  CoachAction,
  'title' | 'detail' | 'items' | 'itemTexts' | 'titleText' | 'detailText' | 'linkText'
> & { link: { label: string } };

/**
 * The words of one coach action. `fieldLabel` writes a listing field as the store names it (it needs the platform:
 * the Google Play title is a "Title", the App Store one a "Name").
 */
export function coachWords(
  action: Partial<CoachTexts> & Pick<CoachTexts, 'title' | 'detail' | 'items' | 'link'>,
  fieldLabel: (field: string) => string,
): { title: string; detail: string; items: string[]; linkLabel: string } {
  const items = action.items.map((line, i) => {
    const text = action.itemTexts?.[i];
    if (!text) return line;
    const field = text.params.field;
    return coreMessage(text, line, typeof field === 'string' ? { field: fieldLabel(field) } : {});
  });
  return {
    title: coreMessage(action.titleText, action.title),
    detail: coreMessage(action.detailText, action.detail),
    items,
    linkLabel: coreMessage(action.linkText, action.link.label),
  };
}
