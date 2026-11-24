import { parseViewPath } from './app-scope.ts';

/**
 * The section rail: one list of sections in a rail on the left (grouped, with a count where there is one) and one section at a time
 * on the right, kept in the address as `?section=`. The pattern of the workspace Settings, as a reusable part (components/ui/SectionRail.svelte)
 * for pages that used to stack many collapsible sections (app Builds, Insights overview). Pure functions, like lib/settings-views.ts.
 */

export type RailEntry = {
  id: string;
  label: string;
  /** A number beside the label (items in the section); null or undefined draws nothing. 0 is drawn: "nothing here" is information. */
  count?: number | null | undefined;
  /** A short sentence a screen reader hears after the label ("2 failed"); drawn nowhere else. */
  note?: string | undefined;
};
export type RailGroup = { id: string; label: string; entries: RailEntry[] };

/** Groups with their empty ones left out. */
export const nonEmptyGroups = (groups: readonly RailGroup[]): RailGroup[] =>
  groups.filter((g) => g.entries.length > 0);

/** Every entry of the groups, in order. */
export const railEntries = (groups: readonly RailGroup[]): RailEntry[] =>
  groups.flatMap((g) => g.entries);

/**
 * The section to draw. The address names one with `?section=`; an older address that named a `?view=` opens the section `aliases` maps it
 * to (or the view itself when that is a section). An unknown or unavailable name opens the first section.
 */
export function resolveRailSection(
  hash: string,
  ids: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string {
  const query = parseViewPath(hash).query;
  const asked = query.get('section');
  if (asked && ids.includes(asked)) return asked;
  const view = query.get('view');
  const mapped = view ? (aliases[view] ?? view) : null;
  if (mapped && ids.includes(mapped)) return mapped;
  return ids[0] ?? '';
}

/** The same address on another section: the old `view` is dropped, every other query part stays. */
export function withRailSection(hash: string, id: string): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.delete('view');
  params.set('section', id);
  return `${path}?${params.toString()}`;
}

/** The next or previous entry for an arrow key, wrapping; the id to move to. Home and End go to the ends. */
export function stepRail(ids: readonly string[], current: string, key: string): string | null {
  if (ids.length === 0) return null;
  const at = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowDown' || key === 'ArrowRight') return ids[(at + 1) % ids.length] ?? null;
  if (key === 'ArrowUp' || key === 'ArrowLeft')
    return ids[(at - 1 + ids.length) % ids.length] ?? null;
  if (key === 'Home') return ids[0] ?? null;
  if (key === 'End') return ids[ids.length - 1] ?? null;
  return null;
}
