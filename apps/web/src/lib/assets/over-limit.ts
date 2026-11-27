import type { AssetProblem, StoreImagesView } from '@kiln/core';

/**
 * A set of the store that holds more images than it may (the count problem of `checkStoreImages`), made actionable: which set, which
 * images are the extra ones, so the Graphics tab can offer "Remove the N extra images" instead of the bare error. The count itself is
 * the problem's (the one rule of core); this only finds the images behind it. Pure. Written for the ES2017 web build.
 */
export type OverLimit = {
  /** The Graphics tab's id of the display (`locale/kind/device`), the key of its set. */
  setId: string;
  locale: string;
  /** The store's own group that is over (an App Store placement group), or null. */
  group: string | null;
  count: number;
  max: number;
  /** The extra images, the last ones of the group in the store's own order (the ones past the limit), by `ref` and place. */
  extra: { ref: string; position: number }[];
};

export function overLimitOf(
  problems: readonly AssetProblem[],
  view: Pick<StoreImagesView, 'sets'> | null,
): OverLimit[] {
  const out: OverLimit[] = [];
  if (view === null) return out;
  for (const p of problems) {
    if (p.severity !== 'error' || p.count === undefined || p.max === undefined) continue;
    if (p.count <= p.max || p.locale === undefined || p.kind === undefined) continue;
    const device = p.device === undefined ? null : p.device;
    const group = p.set === undefined ? null : p.set;
    const set = view.sets.filter(
      (s) =>
        s.locale === p.locale &&
        s.kind === p.kind &&
        s.device === device &&
        (group === null || s.target === group),
    )[0];
    if (set === undefined) continue;
    const files = set.files.slice().sort((a, b) => a.position - b.position);
    out.push({
      setId: `${p.locale}/${p.kind}/${device === null ? '' : device}`,
      locale: p.locale,
      group,
      count: p.count,
      max: p.max,
      extra: files.slice(p.max).map((f) => ({ ref: f.ref, position: f.position })),
    });
  }
  return out;
}
