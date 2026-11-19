/**
 * When the page scrolls back to the top, as pure functions. A view switch (`?view=`), the platform scope, the version and locale
 * pickers and filters only change the query of the address: they stay on the same page, so the scroll position stays too. Only a
 * different route path (another page, another app, an opened release) is a new page and starts at the top.
 */

/** The route of an address without its query and fragment: `#/portfolio/7/listing?view=graphics` is `/portfolio/7/listing`. */
export function routePath(hash: string): string {
  const raw = hash.replace(/^#/, '');
  const at = raw.search(/[?#]/);
  const path = (at < 0 ? raw : raw.slice(0, at)).split('/').filter((s) => s !== '');
  return `/${path.join('/')}`;
}

/** True only when the route path changes. A change of the query (view, platform, version, locale, filters) never resets the scroll. */
export const shouldResetScroll = (prev: string, next: string): boolean =>
  routePath(prev) !== routePath(next);

/**
 * The height the page must keep while the new content of a view loads (the old content is replaced by a short placeholder, which
 * would pull the page up and clamp the scroll position): the height before the change, or 0 when nothing needs holding.
 */
export const heightToHold = (reset: boolean, before: number): number =>
  reset || !(before > 0) ? 0 : Math.ceil(before);
