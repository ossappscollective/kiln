import {
  LISTING_FIELD_SPECS,
  type ListingStore,
  type Platform,
  type ProposalItem,
} from '@kiln/core';
import { itemTitle, localeName } from './asset-proposal.ts';
import { assetFileUrl } from './assets/assets.ts';
import { storeThumbUrl } from './assets/sync.ts';
import type { ImagePair, ImageSide } from './diff/image-diff.ts';
import { pairByPosition } from './diff/image-diff.ts';
import type { DiffItem } from './diff/text-diff.ts';
import { t } from './i18n/t.ts';

/**
 * The comparisons of the card "Store assets changed in the repository" (docs/adr/0063-release-asset-proposal.md, ADR 0067): the texts
 * for the diff dialog (store text against repository text) and the image pairs for the viewer (store images against the repository's),
 * built from the proposal response alone. Images are addressed through Kiln's own routes (store thumbnail proxy by opaque ref, the
 * repository file route), never an external address.
 */

const storeOf = (platform: Platform): ListingStore =>
  platform === 'ios' ? 'app_store' : 'google_play';

/** The store limit of a listing field (characters or bytes), when the specs know one. */
export function fieldLimit(
  platform: Platform,
  field: string,
): { limit: number; unit: 'characters' | 'bytes' } | null {
  const spec = LISTING_FIELD_SPECS.find((s) => s.store === storeOf(platform) && s.id === field);
  return spec?.maxLength === undefined ? null : { limit: spec.maxLength, unit: spec.unit };
}

/** The text items of the proposal, in the order of the list, as the diff dialog takes them. Store text is `before`, repository text `after`. */
export function textDiffItems(changes: readonly ProposalItem[], platform: Platform): DiffItem[] {
  const out: DiffItem[] = [];
  for (const item of changes) {
    if (item.kind !== 'text') continue;
    const lim = fieldLimit(platform, item.field);
    out.push({
      key: item.id,
      title: itemTitle(item),
      subtitle: localeName(item.locale),
      before: item.before,
      after: item.after,
      limit: lim?.limit ?? null,
      unit: lim?.unit,
    });
  }
  return out;
}

/** The index of an item among the text items (what the dialog opens at), or 0. */
export const textIndexOf = (items: readonly DiffItem[], id: string): number =>
  Math.max(
    0,
    items.findIndex((i) => i.key === id),
  );

/** The graphics items as image pairs, one pair per position of the set (store image against repository file). `owner` keys each pair to its item. */
export function imagePairs(
  changes: readonly ProposalItem[],
  workspaceId: string,
  appId: string,
): (ImagePair & { itemId: string })[] {
  const out: (ImagePair & { itemId: string })[] = [];
  for (const item of changes) {
    if (item.kind !== 'graphics') continue;
    const before: ImageSide[] = (item.beforeFiles ?? []).map((f) => ({
      url: storeThumbUrl(workspaceId, appId, f.ref, 640),
      width: f.width,
      height: f.height,
      bytes: f.bytes,
      name: f.name,
    }));
    const after: ImageSide[] = item.after.files.map((f) => ({
      url: assetFileUrl(workspaceId, appId, f.path, item.after.commit),
      width: f.width,
      height: f.height,
      bytes: f.bytes,
      name: f.path.split('/').pop() ?? f.path,
    }));
    const name = itemTitle(item);
    for (const pair of pairByPosition(
      before,
      after,
      (n) => t('release-stepper:ap.diff.imageTitle', { title: name, position: n }),
      `${item.id}#`,
    )) {
      out.push({ ...pair, subtitle: localeName(item.locale), itemId: item.id });
    }
  }
  return out;
}

/** The index of the first pair of an item in the list of pairs, or 0. */
export const pairIndexOf = (pairs: readonly { itemId: string }[], id: string): number =>
  Math.max(
    0,
    pairs.findIndex((p) => p.itemId === id),
  );
