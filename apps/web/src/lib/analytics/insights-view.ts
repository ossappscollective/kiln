import type { StatChipModel } from './view.ts';

/**
 * The Insights overview as ONE hierarchy (docs/ux-ia.md "Tabs, rail, scope, sync"): header (app, scope, Sync) > tabs (the pages) > range bar >
 * [rail of sections | content]. The headline figures are the first block of the Overview section, not a band above the rail. This is the
 * pure model that block is drawn from, so every data shape is decided here and tested, not in the markup:
 *   none      no platform has stored data (analytics off, never read, loading or failed): one compact line per platform, never an empty column
 *   grid      one platform has data: its figures in a uniform grid
 *   compare   two or more platforms have data: one table, a row per measure and a column per platform, never two long runs of tiles
 */
export type PlatformShape = 'loading' | 'error' | 'off' | 'empty' | 'data';

/** What one platform record is, from what was read for it: a failed read, no status yet, analytics off, on with nothing stored, or data. */
export function platformShape(read: {
  statusError: boolean;
  enabled: boolean | null;
  stored: boolean;
}): PlatformShape {
  if (read.statusError) return 'error';
  if (read.enabled === null) return 'loading';
  if (read.stored) return 'data';
  return read.enabled ? 'empty' : 'off';
}

export type PlatformView = {
  id: string;
  platform: string;
  shape: PlatformShape;
  chips: StatChipModel[];
};

/** One cell of the comparison: the figure of that platform for the measure, or null when it has none (drawn as a dash). */
export type CompareRow = {
  id: string;
  label: string;
  title: string;
  cells: (StatChipModel | null)[];
};

export type OverviewModel = {
  /** Platforms with stored data, in scope order: these get figures and charts. */
  withData: PlatformView[];
  /** Platforms without: each is ONE compact line (why and how to fix), not a column. */
  without: PlatformView[];
  kpis: 'none' | 'grid' | 'compare';
  /** `grid`: the figures of the one platform. */
  gridChips: StatChipModel[];
  /** `compare`: the platforms (columns) and the measures (rows, the first platform's order first). */
  columns: { id: string; platform: string }[];
  rows: CompareRow[];
  /** A platform has data but none of the figures could be made for the range ("No numbers in this date range"). */
  noNumbers: boolean;
  /** Nothing has data and something is still loading: one skeleton, not an empty block. */
  loading: boolean;
};

export function buildOverview(platforms: readonly PlatformView[]): OverviewModel {
  const withData = platforms.filter((p) => p.shape === 'data');
  const without = platforms.filter((p) => p.shape !== 'data');
  const columns = withData.map((p) => ({ id: p.id, platform: p.platform }));
  const order: string[] = [];
  for (const p of withData) for (const c of p.chips) if (!order.includes(c.id)) order.push(c.id);
  const rows: CompareRow[] = order.map((id) => {
    const cells = withData.map((p) => p.chips.find((c) => c.id === id) ?? null);
    const first = cells.find((c): c is StatChipModel => c !== null) as StatChipModel;
    return { id, label: first.label, title: first.title, cells };
  });
  const kpis: OverviewModel['kpis'] =
    withData.length === 0 || rows.length === 0
      ? 'none'
      : withData.length === 1
        ? 'grid'
        : 'compare';
  return {
    withData,
    without,
    kpis,
    gridChips: kpis === 'grid' ? (withData[0] as PlatformView).chips : [],
    columns,
    rows,
    noNumbers: withData.length > 0 && rows.length === 0,
    loading: withData.length === 0 && without.some((p) => p.shape === 'loading'),
  };
}

/** How many columns the charts get: side by side only when two or more platforms have data. */
export const chartColumns = (withData: number): 1 | 2 => (withData > 1 ? 2 : 1);

/** The compact line's reason: a key into `analytics:overview.empty.*` for each shape that has none. */
export const emptyReason = (shape: PlatformShape): 'off' | 'never' | 'error' | 'loading' =>
  shape === 'off' ? 'off' : shape === 'error' ? 'error' : shape === 'loading' ? 'loading' : 'never';
