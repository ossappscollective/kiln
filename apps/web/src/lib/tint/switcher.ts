/**
 * The app switcher rows wear THEIR OWN app's tint (docs/adr/0068-app-tint.md): the list sits inside the open app's tint scope, so a
 * row without its own scope would show the surrounding app's colours. Pure helpers; the DOM wiring is components/app/AppSwitcherList.svelte.
 */

/** The inline style of a row: the tint of the first record of the app that has one ('' when none is known yet: the row is neutral). */
export function rowTintStyle(
  item: { key: string; ids: readonly string[] },
  styleOf: (appId: string) => string,
): string {
  for (const id of [item.key, ...item.ids]) {
    const style = styleOf(id);
    if (style) return style;
  }
  return '';
}

/** Runs `run` for each queued job with at most `limit` at once, each (key) at most once. Used to warm palettes of visible rows. */
export function createLimiter(limit: number): (key: string, job: () => Promise<unknown>) => void {
  const seen = new Set<string>();
  const queue: (() => Promise<unknown>)[] = [];
  let active = 0;
  const next = (): void => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift() as () => Promise<unknown>;
      active += 1;
      void job()
        .catch(() => {})
        .finally(() => {
          active -= 1;
          next();
        });
    }
  };
  return (key, job) => {
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(job);
    next();
  };
}
