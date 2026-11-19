/** One item of the breadcrumb in the top bar. The last item is the current page and has no link. */
export type Crumb = { label: string; href: string | null; current: boolean; kind: 'workspace' | 'section' | 'app' | 'page' };

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
  if (workspace !== '') items.push({ label: workspace, href: null, current: false, kind: 'workspace' });
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
    items.push({ label: (input.appName ?? '').trim() || 'App', href: withPage ? (input.appHref ?? null) : null, current: !withPage, kind: 'app' });
    if (withPage) items.push({ label: page, href: null, current: true, kind: 'page' });
  }
  return items;
}
