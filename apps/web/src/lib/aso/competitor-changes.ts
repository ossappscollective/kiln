import { type ListingChange, imageKey, wordDiff, type WordSegment } from '@kiln/core';
import { formatList, formatNumber } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';

/**
 * The listing changes of a followed App Store competitor (docs/adr/0056-competitor-listing-watch.md, docs/api/aso.md): what the API
 * answers, the URLs of the image proxy (the app's CSP allows `img-src 'self'` only, so thumbnails come from the server by ref, never by
 * address), and the sentences and strips the Changes section draws. Pure: no network, no clock.
 */

export type ListingChangeRow = {
  id: string;
  competitorId: string;
  detectedAt: number;
  kinds: string[];
  changes: ListingChange[];
};

export type CompetitorChangesPage = {
  competitorId: string;
  watching: { state: 'watched'; since: number } | { state: 'not_watched'; reason: 'play_pages_not_read' };
  lastCheckedAt: number | null;
  retentionDays: number;
  hasMore: boolean;
  changes: ListingChangeRow[];
};

export type CompetitorCheckResult = { competitorId: string; state: 'checked' | 'recent' | 'not_found'; changes: number; checkedAt: number };

export type ScreenshotsChange = Extract<ListingChange, { kind: 'screenshots' }>;

const asoBase = (workspaceId: string, appId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/aso`;

export type ImageSize = 96 | 160 | 320 | 640;

/** A thumbnail of a stored screenshot or icon of a competitor, through the server's proxy. `ref` is `icon`, `s.p.<n>`, `s.i.<n>` or a change ref. */
export const competitorImageUrl = (workspaceId: string, appId: string, competitorId: string, ref: string, size: ImageSize = 160): string =>
  `${asoBase(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/image?ref=${encodeURIComponent(ref)}&size=${size}`;

/** The icon of a result of the add-competitor search, by the `iconRef` the search gave. */
export const searchImageUrl = (workspaceId: string, appId: string, ref: string, size: ImageSize = 96): string =>
  `${asoBase(workspaceId, appId)}/competitors/search-image?ref=${encodeURIComponent(ref)}&size=${size}`;

const deviceKey = (c: ScreenshotsChange) => (c.device === 'iphone' ? 'p' : 'i');
/** The ref of one image of a change: `c.<change>.<b|a>.<icon|p|i>.<n>`. */
export const changeImageRef = (changeId: string, side: 'before' | 'after', what: 'icon' | 'p' | 'i', index: number): string =>
  `c.${changeId}.${side === 'before' ? 'b' : 'a'}.${what}.${index}`;

export type StripItem = { ref: string; n: number; total: number; status: 'kept' | 'removed' | 'new' };

/** The screenshots of one side of a change (at most 20), each marked kept, removed (before only) or new (after only). */
export function stripOf(changeId: string, c: ScreenshotsChange, side: 'before' | 'after'): StripItem[] {
  const own = side === 'before' ? c.before : c.after;
  const other = new Set((side === 'before' ? c.after : c.before).map(imageKey));
  return own.slice(0, 20).map((url, i) => ({
    ref: changeImageRef(changeId, side, deviceKey(c), i),
    n: i + 1,
    total: own.length,
    status: other.has(imageKey(url)) ? 'kept' : side === 'before' ? 'removed' : 'new',
  }));
}

export const sideWord = (side: 'before' | 'after'): string => (side === 'before' ? t('aso:changes.side.before') : t('aso:changes.side.after'));
export const deviceWord = (device: 'iphone' | 'ipad'): string => (device === 'iphone' ? t('aso:changes.device.iphone') : t('aso:changes.device.ipad'));

/** "Screenshot 3 of 8, before" (with ", removed" or ", new" when it is not one of the kept ones). */
export function shotAlt(item: StripItem, side: 'before' | 'after', device: 'iphone' | 'ipad'): string {
  const base = t('aso:changes.shotAlt', { n: item.n, total: item.total, side: sideWord(side), device: deviceWord(device) });
  return item.status === 'kept' ? base : t('aso:changes.shotAltStatus', { text: base, status: item.status === 'removed' ? t('aso:changes.status.removed') : t('aso:changes.status.new') });
}

const stars = (milli: number | null): string => (milli === null ? '–' : formatNumber(milli / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
const plain = (v: string | number | null): string => (v === null || v === '' ? '–' : String(v));

/** One sentence for one change, in the language of the page. */
export function changeSentence(c: ListingChange): string {
  switch (c.kind) {
    case 'screenshots': {
      const parts: string[] = [];
      if (c.replaced > 0) parts.push(t('aso:changes.part.replaced', { count: c.replaced }));
      if (c.added > 0) parts.push(t('aso:changes.part.added', { count: c.added }));
      if (c.removed > 0) parts.push(t('aso:changes.part.removed', { count: c.removed }));
      if (c.reordered) parts.push(t('aso:changes.part.reordered'));
      return t('aso:changes.screenshots', { device: deviceWord(c.device), parts: formatList(parts) });
    }
    case 'icon':
      return t('aso:changes.icon');
    case 'name':
      return t('aso:changes.name');
    case 'description':
      return t('aso:changes.description');
    case 'releaseNotes':
      return t('aso:changes.releaseNotes');
    case 'category':
      return t('aso:changes.category', { from: plain(c.before), to: plain(c.after) });
    case 'price':
      return t('aso:changes.price', { from: plain(c.before), to: plain(c.after) });
    case 'version':
      return t('aso:changes.version', { from: plain(c.before), to: plain(c.after) });
    case 'rating':
      return t('aso:changes.rating', { from: stars(typeof c.before === 'number' ? c.before : null), to: stars(typeof c.after === 'number' ? c.after : null) });
    case 'ratingCount':
      return t('aso:changes.ratingCount', {
        from: typeof c.before === 'number' ? formatNumber(c.before) : '–',
        to: typeof c.after === 'number' ? formatNumber(c.after) : '–',
      });
  }
}

/** Changes that have a text to compare word by word. */
export const hasTextDiff = (c: ListingChange): c is Extract<ListingChange, { kind: 'name' | 'description' | 'releaseNotes' }> =>
  c.kind === 'name' || c.kind === 'description' || c.kind === 'releaseNotes';

export const diffOf = (c: { before: string | null; after: string | null }): WordSegment[] => wordDiff(c.before, c.after);

/** The page size of the list and what "older" asks for. */
export const CHANGES_PAGE = 10;
export const oldestOf = (rows: readonly ListingChangeRow[]): number | undefined => rows.length === 0 ? undefined : (rows[rows.length - 1] as ListingChangeRow).detectedAt;

export type ChangesStatus =
  | { kind: 'notWatched' }
  | { kind: 'notChecked' }
  | { kind: 'firstOnly'; since: number }
  | { kind: 'none'; since: number; checkedAt: number }
  | { kind: 'list'; since: number; checkedAt: number | null };

/** What the line above the list says. The history starts when following began: this is never "no changes ever". */
export function changesStatus(page: Pick<CompetitorChangesPage, 'watching' | 'lastCheckedAt' | 'changes'>): ChangesStatus {
  if (page.watching.state === 'not_watched') return { kind: 'notWatched' };
  const since = page.watching.since;
  if (page.changes.length > 0) return { kind: 'list', since, checkedAt: page.lastCheckedAt };
  if (page.lastCheckedAt === null) return { kind: 'notChecked' };
  if (page.lastCheckedAt - since < 60_000) return { kind: 'firstOnly', since };
  return { kind: 'none', since, checkedAt: page.lastCheckedAt };
}
