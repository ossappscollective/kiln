import { fullTime } from './format.ts';
import { t } from './i18n/t.ts';
import type { CartRow } from './pending-cart.ts';
import type { PendingItem, PendingKind } from './pending.ts';

/**
 * What a row of the per-app "Pending changes" page expands to (docs/adr/0067-diff-and-preview.md), pure. The page lists items beyond the
 * cart, so a row's preview comes from one of two sources:
 *  - a STAGED item (listing texts, a graphics set, a release field) is made of cart items: the same ids, the same lazy detail and the
 *    same shared preview (`CartRowPreview`) as the cart drawer and the workspace Pending page;
 *  - any other item (a pushed draft, a draft release, a version in review or approved, a due rollout step) is read from
 *    `GET /apps/{id}/pending/detail?kind=&id=` and shown as plain facts: what it contains and what happens next.
 */

export const DETAIL_KINDS = ['pushed_draft', 'draft_release', 'in_review', 'approved', 'rollout_step'] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];
export const isDetailKind = (kind: PendingKind): kind is DetailKind => (DETAIL_KINDS as readonly string[]).includes(kind);

/** `GET /apps/{id}/pending/detail`: what one item that is not a staged change contains. Never a text, a file or a hash. */
export type PendingItemDetail = {
  kind: DetailKind;
  id: string;
  pushedDraft?: {
    versionString: string | null;
    pushedAt: number;
    texts: { locale: string; field: string }[];
    sets: { locale: string; key: string; kind: string; device: string | null; files: number }[];
    release: { track: string; codes: string[] } | null;
    truncated: boolean;
  };
  draftRelease?: { track: string; codes: string[]; since: number | null };
  release?: { version: string; track: string | null; status: 'in_review' | 'approved'; since: number | null };
  rolloutStep?: { planVersion: string; percent: number; plannedAt: number };
};

/** The key of a row in the expand state: the record (app) and the item. */
export const itemKey = (appId: string, item: Pick<PendingItem, 'id'>): string => `${appId}/${item.id}`;

/** The cart item ids a staged item is made of (`listing_text` has one per staged text). Empty for every other kind. */
export function cartIdsOf(item: Pick<PendingItem, 'kind' | 'id' | 'refs'>): string[] {
  if (item.kind === 'listing_text') return item.refs.map((r) => `listing:${r.id}`);
  if (item.kind === 'asset_set') return [`graphics:${item.id}`];
  if (item.kind === 'release_field') return [`release:${item.id}`];
  return [];
}

export type RowPlan =
  /** A staged item: its cart rows (shared preview each). `missing`: parts that are not in the cart now; `loaded`: the cart was read. */
  | { source: 'cart'; rows: CartRow[]; missing: number; loaded: boolean }
  /** Any other item: read from the pending detail endpoint. */
  | { source: 'detail'; kind: DetailKind }
  /** A kind this page does not know (a newer server): said in words, nothing is guessed. */
  | { source: 'none' };

export function planOf(item: Pick<PendingItem, 'kind' | 'id' | 'refs'>, cartRows: readonly CartRow[] | null): RowPlan {
  if (isDetailKind(item.kind)) return { source: 'detail', kind: item.kind };
  const ids = cartIdsOf(item);
  if (ids.length === 0) return { source: 'none' };
  if (cartRows === null) return { source: 'cart', rows: [], missing: ids.length, loaded: false };
  const rows = ids.map((id) => cartRows.find((r) => r.id === id)).filter((r): r is CartRow => r !== undefined);
  return { source: 'cart', rows, missing: ids.length - rows.length, loaded: true };
}

/** The staged items need the app's cart (for thumbnails, versions and the shared preview); the others do not. */
export const needsCart = (item: Pick<PendingItem, 'kind'>): boolean => item.kind === 'listing_text' || item.kind === 'asset_set' || item.kind === 'release_field';

/** The inline thumbnails of a collapsed graphics row, from the cart item of the set (empty when the cart has none or is not read yet). */
export function thumbsOf(item: Pick<PendingItem, 'kind' | 'id'>, cartRows: readonly CartRow[] | null): { thumbs: string[]; before: number | null } {
  if (item.kind !== 'asset_set' || cartRows === null) return { thumbs: [], before: null };
  const row = cartRows.find((r) => r.id === `graphics:${item.id}`);
  return { thumbs: row?.thumbs ?? [], before: row?.counts.before ?? null };
}

/** Only this many staged texts of a `listing_text` row are previewed at first (each one reads its own detail). */
export const FIRST_ROWS = 5;

export type DetailView = { intro: string; groups: { heading: string; lines: string[] }[]; notes: string[] };

const codesText = (codes: readonly string[]) => codes.join(', ');

/** The facts of a detail as sentences: what it contains, then what happens next. Null when the detail does not fit the kind. */
export function detailView(detail: PendingItemDetail): DetailView | null {
  if (detail.kind === 'pushed_draft' && detail.pushedDraft) {
    const d = detail.pushedDraft;
    const groups: DetailView['groups'] = [];
    if (d.texts.length > 0) groups.push({ heading: t('publish:pending.preview.texts', { count: d.texts.length }), lines: d.texts.map((x) => t('publish:pending.preview.textLine', { locale: x.locale, field: x.field })) });
    if (d.sets.length > 0) groups.push({ heading: t('publish:pending.preview.sets', { count: d.sets.length }), lines: d.sets.map((x) => t('publish:pending.preview.setLine', { locale: x.locale, key: x.key, count: x.files })) });
    if (d.release) groups.push({ heading: t('publish:pending.preview.pushedRelease', { track: d.release.track, codes: codesText(d.release.codes) }), lines: [] });
    return {
      intro: [t('publish:pending.preview.pushedIntro'), d.versionString ? t('publish:pending.preview.pushedVersion', { version: d.versionString }) : '', t('publish:pending.preview.pushedAt', { when: fullTime(d.pushedAt) })].filter((s) => s !== '').join(' '),
      groups,
      notes: [...(d.truncated ? [t('publish:pending.preview.pushedTruncated', { count: 200 })] : []), t('publish:pending.preview.pushedNext')],
    };
  }
  if (detail.kind === 'draft_release' && detail.draftRelease) {
    const d = detail.draftRelease;
    return {
      intro: t('publish:pending.preview.draftReleaseIntro', { track: d.track }),
      groups: [{ heading: d.codes.length > 0 ? t('publish:pending.preview.codes', { codes: codesText(d.codes) }) : t('publish:pending.preview.noCodes'), lines: [] }],
      notes: [t('publish:pending.preview.draftReleaseNext')],
    };
  }
  if ((detail.kind === 'in_review' || detail.kind === 'approved') && detail.release) {
    const r = detail.release;
    const name = r.track ? `${r.version} (${r.track})` : r.version;
    return r.status === 'in_review'
      ? { intro: t('publish:pending.preview.reviewIntro', { name }), groups: [], notes: [t('publish:pending.preview.reviewNext')] }
      : { intro: t('publish:pending.preview.approvedIntro', { name }), groups: [], notes: [t('publish:pending.preview.approvedNext')] };
  }
  if (detail.kind === 'rollout_step' && detail.rolloutStep) {
    const s = detail.rolloutStep;
    return {
      intro: `${t('publish:pending.preview.rolloutIntro', { version: s.planVersion, percent: s.percent })} ${t('publish:pending.preview.rolloutPlanned', { when: fullTime(s.plannedAt) })}`,
      groups: [],
      notes: [t('publish:pending.preview.rolloutNext')],
    };
  }
  return null;
}

/** A detail is kept for the lifetime of the page, keyed by app, kind, id and the time the item started waiting (a changed item is read again). */
export const itemDetailKey = (appId: string, item: Pick<PendingItem, 'kind' | 'id' | 'since'>): string => `${appId}|${item.kind}|${item.id}|${item.since ?? ''}`;
