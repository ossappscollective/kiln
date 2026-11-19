/** One item of the breadcrumb in the top bar. The last item is the current page and has no link. */
export type Crumb = {
  label: string;
  href: string | null;
  current: boolean;
  kind: 'workspace' | 'section' | 'app' | 'page';
};

/**
 * The breadcrumb: workspace, then the section (a link when an app is open), then the app and, when given, the page of the app
 * ("Insights"). The app is a link to its overview while a page follows it. Empty labels are dropped so the bar never shows a lone separator.
 */
export function breadcrumbItems(input: {
  workspace?: string | null;
  section?: { label: string; href: string } | null;
  appName?: string | null;
  appOpen: boolean;
  /** The page of the open app (its slim header title) and the address of the app's overview. */
  page?: string | null;
  appHref?: string | null;
}): Crumb[] {
  const items: Crumb[] = [];
  const workspace = (input.workspace ?? '').trim();
  if (workspace !== '')
    items.push({ label: workspace, href: null, current: false, kind: 'workspace' });
  if (input.section && input.section.label.trim() !== '') {
    items.push({
      label: input.section.label,
      href: input.appOpen ? input.section.href : null,
      current: !input.appOpen,
      kind: 'section',
    });
  }
  const page = (input.page ?? '').trim();
  if (input.appOpen) {
    const withPage = page !== '';
    items.push({
      label: (input.appName ?? '').trim() || 'App',
      href: withPage ? (input.appHref ?? null) : null,
      current: !withPage,
      kind: 'app',
    });
    if (withPage) items.push({ label: page, href: null, current: true, kind: 'page' });
  }
  return items;
}

/** What the top bar draws: whole crumbs and, when space is tight, one "more" item whose menu holds the crumbs left out. */
export type ShownCrumb =
  | Crumb
  | { kind: 'more'; label: string; href: null; current: false; menu: Crumb[] };

/** The room a list of crumbs takes, in characters: the labels and a separator between neighbours. A "more" item counts as 1. */
const widthOf = (items: readonly ShownCrumb[]): number =>
  items.reduce((sum, c) => sum + (c.kind === 'more' ? 1 : c.label.length) + 3, -3);

const more = (menu: Crumb[]): ShownCrumb => ({
  kind: 'more',
  label: 'More of the path',
  href: null,
  current: false,
  menu,
});

/**
 * Fits the breadcrumb into `maxChars` characters (the Shell turns the width of the bar into characters) WITHOUT cutting any label:
 * 1. everything;
 * 2. workspace, app, page (the section link, "All apps", goes first: the left menu has it);
 * 3. workspace, an ellipsis menu holding the middle crumbs, the last crumb;
 * 4. an ellipsis menu holding everything before the last crumb, then the last crumb.
 * The last crumb (the page you are on) is always shown whole. The first level that fits wins; when none does, the last one is used
 * and the page then truncates by itself. The menu only lists crumbs that are links (a workspace has no page of its own).
 */
export function fitCrumbs(items: readonly Crumb[], maxChars: number): ShownCrumb[] {
  if (items.length <= 1 || widthOf(items) <= maxChars) return [...items];
  const last = items[items.length - 1] as Crumb;
  const slim =
    items.length > 3 && items.some((c) => c.kind === 'section')
      ? items.filter((c) => c.kind !== 'section' || c === last)
      : [...items];
  if (widthOf(slim) <= maxChars) return slim;
  const first = slim[0] as Crumb;
  const links = (list: Crumb[]) => list.filter((c) => c.href !== null);
  const middle = slim.slice(1, -1);
  if (links(middle).length > 0) {
    const shown = [first, more(links(middle)), last];
    if (widthOf(shown) <= maxChars) return shown;
  }
  const before = slim.slice(0, -1);
  const menu = links(before);
  return menu.length > 0 ? [more(menu), last] : [last];
}

/** How many characters fit in `pixels` of bar, at about `charPx` a character (the separators are counted by `fitCrumbs`). Never below 8. */
export const charsFor = (pixels: number, charPx = 7.4): number =>
  Math.max(8, Math.floor(pixels / charPx));
