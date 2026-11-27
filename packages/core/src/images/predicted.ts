import type { StoreImagesView } from '../listing/asset-sync.ts';
import { assetStoreOf } from '../listing/staged-changes.ts';
import type { AssetFacts, AssetKind, AssetProblem } from '../listing/store-asset-specs.ts';
import { assetFact, imagePathOf, validateImageFacts } from './facts.ts';
import { type DisplaySet, displayKeyOf, groupStoreImages } from './groups.ts';

/**
 * The images AFTER the staged changes (docs/state-model.md, "Single owners (core)"). The Graphics tab judged the store's view only
 * ("12 found" stayed up, with its error, after the extra images were staged for removal) while the server's readiness judged the draft a
 * push would leave (`predictDraft`): two answers to "is it fine now". This is the display-level prediction, the same rule as `predictDraft`:
 * a push makes the display (the set of one locale, kind and device) EXACTLY the staged files, in whatever placement groups it sits; a sibling
 * group of the same display is removed with it; a set staged empty (`cleared`) removes the display; a display the store does not have yet
 * is created. Everything not staged is kept as the store holds it, group by group.
 *
 * PUSHED AND UNPUSHED, EXPLICITLY. A staged set marked `pushed` has been written to the store already. A view read AFTER that push (every
 * push drops the read caches) already holds it, so applying it again would change nothing (and would hide a change somebody made in the
 * console since): by default pushed sets are NOT applied (`pushed: 'ignore'`). For a view older than the push, ask `pushed: 'apply'`.
 * Unpushed sets are always applied. The result says how many of each were seen.
 *
 * Pure. ES2017.
 */

export type StagedImage = {
  width: number | null;
  height: number | null;
  name?: string | null | undefined;
};

/** One staged set: the files the display holds after the push, in order. */
export type StagedImageSet = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  files: readonly StagedImage[];
  /** Staged empty: a push removes every image of the display. (`files` is then empty.) */
  cleared?: boolean | undefined;
  /** Written to the store already (see `isUnpushed`). */
  pushed?: boolean | undefined;
  /** The store's name of the group the set is written to, when known; else the display's primary group, else the slot. */
  target?: string | undefined;
};

export type PredictedImage = {
  width: number | null;
  height: number | null;
  name: string | null;
  /** The image is a staged one (not in the store yet). */
  staged: boolean;
  /** The store's ref when the image is the store's own (a removal or a pull selects by it); null for a staged one. */
  ref: string | null;
  /** The group it sits in after the push. */
  group: string;
  /** The pixel size was measured from the file header (the store gave none): only ever a note. */
  measured?: boolean | undefined;
};

export type PredictedDisplay = {
  key: string;
  locale: string;
  kind: AssetKind;
  device: string | null;
  /** The staged set replaced the display. */
  touched: boolean;
  /** Images in the order of the display (the primary group first). */
  images: PredictedImage[];
  /** Per group, after the push: ONE group for a touched display, the store's groups for an untouched one. */
  groups: { target: string; count: number }[];
  count: number;
};

export type PredictedImages = {
  displays: PredictedDisplay[];
  facts: AssetFacts[];
  /** `validateAssets` over `facts`: the same rule the Graphics tab and the readiness count by. */
  problems: AssetProblem[];
  /** Staged sets that were applied, and pushed ones that were left out. */
  applied: number;
  skippedPushed: number;
};

export function predictedImagesOf(
  view: Pick<StoreImagesView, 'platform' | 'sets'>,
  staged: readonly StagedImageSet[],
  options: { pushed?: 'ignore' | 'apply' } = {},
): PredictedImages {
  const store = assetStoreOf(view.platform);
  const apply = options.pushed === 'apply';
  const byKey = new Map<string, PredictedDisplay>();
  const order: string[] = [];
  const stored: DisplaySet[] = groupStoreImages(view);
  for (const d of stored) {
    const images: PredictedImage[] = d.images.map((i) => ({
      width: i.file.width,
      height: i.file.height,
      name: i.file.name,
      staged: false,
      ref: i.file.ref,
      group: i.group,
      ...(i.file.sizeFrom === 'header' ? { measured: true } : {}),
    }));
    byKey.set(d.key, {
      key: d.key,
      locale: d.locale,
      kind: d.kind,
      device: d.device,
      touched: false,
      images,
      groups: d.counts.perGroup.map((g) => ({ target: g.target, count: g.count })),
      count: images.length,
    });
    order.push(d.key);
  }
  let applied = 0;
  let skippedPushed = 0;
  for (const s of staged) {
    if (s.pushed === true && !apply) {
      skippedPushed += 1;
      continue;
    }
    applied += 1;
    const key = displayKeyOf(s);
    const was = stored.filter((d) => d.key === key)[0];
    const target = was !== undefined ? was.pushTarget : (s.target ?? `${s.kind}${s.device === null ? '' : `:${s.device}`}`);
    const files = s.cleared === true ? [] : s.files;
    const images: PredictedImage[] = files.map((f) => ({
      width: f.width,
      height: f.height,
      name: f.name ?? null,
      staged: true,
      ref: null,
      group: s.target ?? target,
    }));
    const group = s.target ?? target;
    if (byKey.get(key) === undefined) order.push(key);
    byKey.set(key, {
      key,
      locale: s.locale,
      kind: s.kind,
      device: s.device,
      touched: true,
      images,
      groups: images.length === 0 ? [] : [{ target: group, count: images.length }],
      count: images.length,
    });
  }
  const displays = order
    .map((k) => byKey.get(k) as PredictedDisplay)
    .filter((d) => d.count > 0 || d.touched === false)
    .sort((x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  const facts: AssetFacts[] = [];
  const measured = new Set<string>();
  for (const d of displays) {
    d.images.forEach((image, index) => {
      if (image.measured === true)
        measured.add(imagePathOf({ locale: d.locale, kind: d.kind, device: d.device, position: index + 1 }));
      facts.push(
        assetFact({
          store,
          locale: d.locale,
          kind: d.kind,
          device: d.device,
          group: image.group,
          position: index + 1,
          name: image.name,
          width: image.width,
          height: image.height,
        }),
      );
    });
  }
  return {
    displays,
    facts,
    problems: validateImageFacts(store, facts, measured),
    applied,
    skippedPushed,
  };
}
