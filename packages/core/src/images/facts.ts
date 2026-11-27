import type { StoreImagesView } from '../listing/asset-sync.ts';
import type { ImageFormat } from '../listing/image-header.ts';
import { assetStoreOf } from '../listing/staged-changes.ts';
import {
  type AssetFacts,
  type AssetKind,
  type AssetProblem,
  type AssetStore,
  validateAssets,
} from '../listing/store-asset-specs.ts';
import type { DisplaySet } from './groups.ts';

/**
 * ONE `AssetFacts` builder for images (docs/state-model.md, "Single owners (core)"). The same screenshot used to get a different `path`,
 * extension and size source depending on the screen that judged it: `checkStoreImages` (`locale/kind/device#position`, extension from the
 * name, '' without one), `assetFactsOf` of the draft content (`locale/target/index`, extension hard-coded `png`), the staged set facts
 * (real file data, per set) and the repository index (repo path). A problem could not be matched between screens by path. Now:
 *
 *  - PATH. An image of a store, a draft or a staged set is `locale/kind/device#position` (`en-US/screenshot/ipad_13#4`, `device` is `all`
 *    for a kind without one). `position` is the 1-based place in the DISPLAY (sibling placement groups continue the counter, as the
 *    store's own positions do), so the path is unique per display; the group it sits in is `AssetFacts.set`. A repository file keeps its
 *    repository path (`path` given).
 *  - SET. An App Store image carries its placement group in `set`, so Apple's limit of 10 is counted per group and never summed across
 *    siblings; Google Play has one group per device (null).
 *  - EXTENSION. Given, else from the name, else from the content format, else `png`: a store that gives no file name is never judged by
 *    an extension it did not give (before, a nameless Apple image was reported as "It is .").
 *  - READ. `read` when both pixel sizes are known, else `not_read` (never an error).
 *
 * Pure. ES2017.
 */

export type ImageFactInput = {
  store: AssetStore;
  locale: string;
  kind: AssetKind;
  device: string | null;
  /** The store's own group (App Store placement group), null when not known or not per group. */
  group?: string | null | undefined;
  /** 1-based, among the images of the display. */
  position: number;
  /** The file name, when the store or the staged file gives one. */
  name?: string | null | undefined;
  /** Lower case extension without the dot, when known better than the name says. */
  extension?: string | undefined;
  format?: ImageFormat | 'video' | null | undefined;
  width: number | null;
  height: number | null;
  bytes?: number | null | undefined;
  hasAlpha?: boolean | null | undefined;
  read?: AssetFacts['read'] | undefined;
  /** A repository file's own path; the others get `imagePathOf`. */
  path?: string | undefined;
};

/** The path of one image of a store, draft or staged set (see the file comment). */
export const imagePathOf = (ref: {
  locale: string;
  kind: AssetKind;
  device: string | null;
  position: number;
}): string => `${ref.locale}/${ref.kind}/${ref.device ?? 'all'}#${ref.position}`;

const extensionOf = (name: string | null | undefined): string => {
  const base = (name ?? '').split('/').pop() ?? '';
  const at = base.lastIndexOf('.');
  const ext = at < 0 ? '' : base.slice(at + 1).toLowerCase();
  return ext === 'jpg' ? 'jpeg' : ext;
};

/** The facts of one image. */
export function assetFact(input: ImageFactInput): AssetFacts {
  const fromName = extensionOf(input.name);
  const extension =
    input.extension ??
    (fromName !== ''
      ? fromName
      : input.format !== undefined && input.format !== null && input.format !== 'video'
        ? input.format
        : 'png');
  const known = input.width !== null && input.height !== null;
  return {
    path: input.path ?? imagePathOf(input),
    store: input.store,
    locale: input.locale,
    kind: input.kind,
    device: input.device,
    set: input.store === 'app_store' ? (input.group ?? null) : null,
    order: input.position,
    bytes: input.bytes ?? null,
    width: input.width,
    height: input.height,
    format: input.format ?? null,
    extension,
    hasAlpha: input.hasAlpha ?? null,
    read: input.read ?? (known ? 'read' : 'not_read'),
  };
}

/** The facts of every image of a store read (the store's own positions, the group of each). */
export function storeImageFacts(view: Pick<StoreImagesView, 'platform' | 'sets'>): AssetFacts[] {
  const store = assetStoreOf(view.platform);
  const out: AssetFacts[] = [];
  for (const set of view.sets) {
    for (const f of set.files) {
      out.push(
        assetFact({
          store,
          locale: set.locale,
          kind: set.kind,
          device: set.device,
          group: set.target,
          position: f.position,
          name: f.name,
          width: f.width,
          height: f.height,
          bytes: f.bytes,
        }),
      );
    }
  }
  return out;
}

/** The facts of the images of display sets, in the merged order of each display. */
export function displayImageFacts(displays: readonly DisplaySet[]): AssetFacts[] {
  const out: AssetFacts[] = [];
  for (const d of displays) {
    const store = assetStoreOf(d.platform);
    d.images.forEach((image, index) => {
      out.push(
        assetFact({
          store,
          locale: d.locale,
          kind: d.kind,
          device: d.device,
          group: image.group,
          position: index + 1,
          name: image.file.name,
          width: image.file.width,
          height: image.file.height,
          bytes: image.file.bytes,
        }),
      );
    });
  }
  return out;
}

/** The paths of the images whose pixel size this server measured itself from the file header (the store gave none). */
export function measuredPathsOf(view: Pick<StoreImagesView, 'sets'>): Set<string> {
  const measured = new Set<string>();
  for (const set of view.sets) {
    for (const f of set.files) {
      if (f.sizeFrom === 'header')
        measured.add(
          imagePathOf({
            locale: set.locale,
            kind: set.kind,
            device: set.device,
            position: f.position,
          }),
        );
    }
  }
  return measured;
}

/**
 * Holds image facts against the documented specs (`validateAssets`, the counting rule: per store set) and demotes what rests on a size
 * measured from a file header to a note: a reading is not a fact of the store, so a wrong one can neither block nor frighten.
 */
export function validateImageFacts(
  store: AssetStore,
  facts: readonly AssetFacts[],
  measured: ReadonlySet<string> = new Set<string>(),
): AssetProblem[] {
  const found = validateAssets(store, facts);
  if (measured.size === 0) return found;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return found
    .map((p) =>
      p.path !== undefined && measured.has(p.path) && p.severity !== 'info'
        ? {
            ...p,
            severity: 'info' as const,
            message: `${p.message} (The size was read from the file header, as the store gives none, so this is a note.)`,
          }
        : p,
    )
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}
