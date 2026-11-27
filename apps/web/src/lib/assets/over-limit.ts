import type { AssetProblem } from '@kiln/core';
import type { GraphicLocale, GraphicSet } from './graphic-sets.ts';

/**
 * A set that holds more images than it may, made actionable: which set, which rows are the extra ones, so the Graphics tab can offer
 * "Remove the N extra images" instead of the bare error. Two causes, one action:
 *  - `group`: a store group (or a staged set, after the staged changes) is over the rule's count (`validateAssets`, the one rule of core;
 *    the problem carries `count`, `max` and the group);
 *  - `display`: every store group is within its own limit (10 + 2 across two placement groups) but the display, which one staged set
 *    replaces, holds more than a staged set may (`GraphicSet.total` over `stagedMax`): it must be trimmed before it can be edited.
 * The rows are the set's own: a store set's rows are named by their store `ref`, a staged set's by `staged:<oid>:<n>`, so the removal that
 * follows takes either kind (the staged ones go to the staged operations). The limit is the set's (`GraphicSet.max`/`stagedMax` from the
 * core owner); this file has none of its own. Pure. Written for the ES2017 web build.
 */
export type OverLimit = {
  /** The Graphics tab's id of the display (`locale/kind/device`), the key of its set. */
  setId: string;
  locale: string;
  /** The store's own group that is over (an App Store placement group), or null. */
  group: string | null;
  cause: 'group' | 'display';
  count: number;
  max: number;
  /** The extra rows, the last ones past the limit, by the key `GraphicRow.key` and place. */
  extra: { key: string; position: number }[];
};

const idOf = (locale: string, kind: string, device: string | null) => `${locale}/${kind}/${device === null ? '' : device}`;

export function overLimitOf(
  problems: readonly AssetProblem[],
  locales: readonly GraphicLocale[],
): OverLimit[] {
  const out: OverLimit[] = [];
  const sets: GraphicSet[] = [];
  for (const l of locales) for (const s of l.sets) sets.push(s);
  const find = (id: string): GraphicSet | undefined => sets.filter((s) => s.id === id)[0];
  const seen: Record<string, true | undefined> = {};
  for (const p of problems) {
    if (p.severity !== 'error' || p.count === undefined || p.max === undefined) continue;
    if (p.count <= p.max || p.locale === undefined || p.kind === undefined) continue;
    const device = p.device === undefined ? null : p.device;
    const group = p.set === undefined ? null : p.set;
    const set = find(idOf(p.locale, p.kind, device));
    if (set === undefined) continue;
    const rows = set.staged || group === null ? set.rows : set.rows.filter((r) => r.group === group);
    const mark = `${set.id}|${group ?? ''}`;
    if (seen[mark]) continue;
    seen[mark] = true;
    out.push({
      setId: set.id,
      locale: p.locale,
      group,
      cause: 'group',
      count: p.count,
      max: p.max,
      extra: rows.slice(p.max).map((r) => ({ key: r.key, position: r.position })),
    });
  }
  for (const set of sets) {
    if (set.staged || set.total <= set.stagedMax || seen[`${set.id}|`] || out.some((o) => o.setId === set.id)) continue;
    out.push({
      setId: set.id,
      locale: set.locale,
      group: null,
      cause: 'display',
      count: set.total,
      max: set.stagedMax,
      extra: set.rows.slice(set.stagedMax).map((r) => ({ key: r.key, position: r.position })),
    });
  }
  return out;
}
