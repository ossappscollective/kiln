import {
  type AssetProblem,
  checkStoreImages,
  type DisplaySet,
  groupStoreImages,
  type Platform,
  type PredictedImages,
  predictedImagesOf,
  type StagedChangesView,
  type StagedImageSet,
  type StoreImagesView,
  type StoreSide,
  storeSideOf,
} from '@kiln/core';
import { type AddressBook, buildGraphicSets, type GraphicLocale } from '../assets/graphic-sets.ts';
import { type OverLimit, overLimitOf } from '../assets/over-limit.ts';
import { storeKeyOf } from '../assets/sync.ts';

/**
 * What every screen shows about the store's images, DERIVED from one store view and the staged view with the core owners
 * (`groupStoreImages`, `checkStoreImages`, `predictedImagesOf`, `storeSideOf`). Plain TypeScript (no runes): the web store of the store's
 * images (store-images-store.svelte.ts) keeps the view and calls this; the consistency harness (projections.ts) calls the SAME function,
 * so what a surface shows and what the harness projects cannot be two computations. This is the only place in the web app that judges a
 * store view (`checkStoreImages`) or predicts the store after the staged changes (`predictedImagesOf`).
 */

export type ImagesChannel = 'editable' | 'live';

/** The staged sets, in the shape `predictedImagesOf` reads. */
export function stagedImageSetsOf(view: StagedChangesView | null): StagedImageSet[] {
  if (view === null) return [];
  return view.assets.map((a) => ({
    locale: a.locale,
    kind: a.slot.kind,
    device: a.slot.device,
    files: a.files.map((f) => ({
      width: f.width,
      height: f.height,
      name: f.path.split('/').pop() ?? f.path,
    })),
    cleared: a.cleared === true,
    pushed: a.pushed,
  }));
}

/**
 * One display the pull dialog offers. A pull takes the PRIMARY group of a display (`primaryStoreSet`: the placement group Apple shows for
 * the device size and the one a push writes; a legacy group of the same display is a fallback the store keeps, not another set of
 * screenshots), so `count` is the primary group's and `others` the images of the display's other groups, which stay in the store.
 */
export type PullChoice = { key: string; display: DisplaySet; count: number; others: number };

export type ImagesFacts = {
  channel: ImagesChannel;
  view: StoreImagesView | null;
  /** THE read clock: when the server read the store (`view.readAt`), null before the first read. */
  readAt: number | null;
  /** A read is on its way. */
  checking: boolean;
  /** Why the last read failed (what is shown stays shown); '' when it did not. */
  problem: string;
  displays: DisplaySet[];
  /** The store as it is now (`checkStoreImages`). */
  problems: AssetProblem[];
  /** The store after the staged changes are pushed, or null when nothing unpushed is staged (or the live channel is shown). */
  predicted: PredictedImages | null;
  /** What the Graphics tab judges: after the staged changes when there are some, else the store as it is. */
  problemsAfter: AssetProblem[];
  /** The blockers of `problemsAfter` (not an info, not an unread file). */
  errors: AssetProblem[];
  graphicSets: GraphicLocale[];
  overLimit: OverLimit[];
  side: StoreSide | null;
  /** The displays with something to pull (`PullChoice`), in display order. */
  pullChoices: PullChoice[];
  unplaced: number;
  counts: {
    /** Images in every graphic set (staged rows replace the store's). */
    images: number;
    locales: number;
    /** Graphic sets with a staged change. */
    staged: number;
    /** The displays a pull offers (`pullChoices`). */
    pullSets: number;
  };
};

/** The facts that come from the view alone (the store adds `channel`, `checking` and `problem`). */
export type DerivedImages = Omit<ImagesFacts, 'checking' | 'problem' | 'channel'>;

/** The facts of one app's store images, from its view and its staged view. Pure; the same arguments give the same answer. */
export function deriveImagesFacts(input: {
  platform: Platform;
  channel: ImagesChannel;
  view: StoreImagesView | null;
  staged: StagedChangesView | null;
  urls: AddressBook;
}): DerivedImages {
  const { platform, channel, view, staged, urls } = input;
  const displays = view ? groupStoreImages(view) : [];
  const problems = view ? checkStoreImages(view) : [];
  const unpushed =
    channel === 'live' ? [] : stagedImageSetsOf(staged).filter((s) => s.pushed !== true);
  const predicted =
    view !== null && unpushed.length > 0
      ? predictedImagesOf(view, unpushed, { pushed: 'ignore' })
      : null;
  const problemsAfter = predicted !== null ? predicted.problems : problems;
  const graphicSets = buildGraphicSets({
    platform,
    view,
    // The live version is shown as the store holds it: what is staged is for the draft.
    staged: channel === 'live' ? null : staged,
    urls,
  });
  const pullChoices: PullChoice[] = displays
    .filter((d) => d.counts.primary > 0)
    .map((d) => ({
      key: storeKeyOf(d.platform, d.locale, d.kind, d.device),
      display: d,
      count: d.counts.primary,
      others: d.counts.merged - d.counts.primary,
    }));
  const facts: DerivedImages = {
    view,
    readAt: view === null ? null : view.readAt,
    displays,
    problems,
    predicted,
    problemsAfter,
    errors: problemsAfter.filter((p) => p.severity !== 'info' && p.rule !== 'inspect.unread'),
    graphicSets,
    overLimit: overLimitOf(problemsAfter, graphicSets),
    side: view === null ? null : storeSideOf(view),
    pullChoices,
    unplaced: view === null ? 0 : view.unplaced,
    counts: {
      images: graphicSets.reduce((n, l) => n + l.imageCount, 0),
      locales: graphicSets.length,
      staged: graphicSets.reduce((n, l) => n + l.sets.filter((s) => s.staged).length, 0),
      pullSets: pullChoices.length,
    },
  };
  return facts;
}
