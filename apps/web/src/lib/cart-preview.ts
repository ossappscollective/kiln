import { type ImagePair, pairByPosition } from './diff/image-diff.ts';
import { k, t } from './i18n/t.ts';
import type { CartDetail, CartRow } from './pending-cart.ts';

/**
 * What a cart row shows when it is expanded (docs/adr/0067-diff-and-preview.md), pure: the view model that the drawer and the
 * workspace Pending page both draw, and the expand state (collapsed by default, per drawer or page session, "Expand all").
 * The detail is read lazily when a row is first expanded (`GET /apps/{id}/pending/cart/detail`); until then only the list's own
 * fields (excerpts, counts, thumbs, price lines) are known.
 */

export type Preview =
  /** A text: listing text (before = the store's text, null when none is stored) or release field (before is never known). */
  | {
      kind: 'text';
      before: string | null;
      after: string;
      limit: number | null;
      unit: 'characters' | 'bytes';
      beforeNote: 'none' | 'unknown' | null;
      truncated: boolean;
      field: string;
      locale: string | null;
    }
  /** Graphics: pairs by position; `beforeKnown` false when no store read is remembered (then only the staged images are shown). */
  | {
      kind: 'images';
      pairs: ImagePair[];
      beforeKnown: boolean;
      truncated: boolean;
      beforeCount: number | null;
      afterCount: number;
    }
  | { kind: 'price' }
  | {
      kind: 'reply';
      text: string;
      truncated: boolean;
      review: {
        rating: number;
        title: string | null;
        body: string;
        language: string | null;
        territory: string | null;
        truncated: boolean;
      };
    }
  /** The detail has not arrived (or does not fit the row): nothing to draw beyond the list's own line. */
  | { kind: 'none' };

/** Every row can be expanded (a price row shows its table, a graphics row its images, a text its diff, a reply the review). */
export const expandable = (_row: CartRow): boolean => true;

export function previewOf(
  row: Pick<CartRow, 'kind' | 'title'>,
  detail: CartDetail | null,
): Preview {
  if (row.kind === 'price') return { kind: 'price' };
  if (detail === null) return { kind: 'none' };
  if ((row.kind === 'listing' || row.kind === 'release') && detail.text) {
    const x = detail.text;
    return {
      kind: 'text',
      before: x.before,
      after: x.after,
      limit: x.limit,
      unit: x.unit,
      beforeNote: x.before !== null ? null : row.kind === 'release' ? 'unknown' : 'none',
      truncated: x.truncated,
      field: x.field,
      locale: x.locale,
    };
  }
  if (row.kind === 'graphics' && detail.graphics) {
    const g = detail.graphics;
    const title = (position: number) =>
      t('app:cart.preview.imageTitle', { title: row.title, position });
    return {
      kind: 'images',
      pairs: pairByPosition(
        (g.before ?? []).map((f) => ({
          url: f.url,
          width: f.width,
          height: f.height,
          bytes: f.bytes,
          name: f.name,
        })),
        g.after.map((f) => ({
          url: f.url,
          width: f.width,
          height: f.height,
          bytes: f.bytes,
          name: f.name,
        })),
        title,
        `${row.title}#`,
      ),
      beforeKnown: g.before !== null,
      truncated: g.truncated,
      beforeCount: g.before === null ? null : g.before.length,
      afterCount: g.after.length,
    };
  }
  if (row.kind === 'review_reply' && detail.reply) return { kind: 'reply', ...detail.reply };
  return { kind: 'none' };
}

/** A pair of a graphics preview that really differs by position: with no store read every staged image is shown as one. */
export const imagePairs = (p: Preview): ImagePair[] => (p.kind === 'images' ? p.pairs : []);

// ----- expand state --------------------------------------------------------------------------------

export type Expanded = ReadonlySet<string>;
export const noneExpanded: Expanded = new Set<string>();

export function toggleExpanded(expanded: Expanded, key: string): Expanded {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const expandAllOf = (rows: readonly Pick<CartRow, 'key'>[]): Expanded =>
  new Set(rows.map((r) => r.key));

/** Keep only keys of rows that are still listed (a refresh or a run removes some). */
export function pruneExpanded(expanded: Expanded, rows: readonly Pick<CartRow, 'key'>[]): Expanded {
  const keys = new Set(rows.map((r) => r.key));
  const kept = [...expanded].filter((key) => keys.has(key));
  return kept.length === expanded.size ? expanded : new Set(kept);
}

/** `all` when every row is expanded (the control then collapses), `some` or `none` otherwise. */
export function expansionOf(
  expanded: Expanded,
  rows: readonly Pick<CartRow, 'key'>[],
): 'none' | 'some' | 'all' {
  const n = rows.filter((r) => expanded.has(r.key)).length;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}

/** The control's next state: collapse when everything is expanded, expand all otherwise. */
export const toggleAll = (expanded: Expanded, rows: readonly Pick<CartRow, 'key'>[]): Expanded =>
  expansionOf(expanded, rows) === 'all' ? noneExpanded : expandAllOf(rows);

// ----- the detail cache ----------------------------------------------------------------------------

/** A detail is kept for the lifetime of the page, keyed by the item AND its version: a changed item is read again. */
export const detailKey = (row: Pick<CartRow, 'appId' | 'id' | 'version'>): string =>
  `${row.appId}|${row.id}|${row.version}`;

export const PREVIEW_KEYS = {
  expand: k('app:cart.preview.expand'),
  collapse: k('app:cart.preview.collapse'),
};
