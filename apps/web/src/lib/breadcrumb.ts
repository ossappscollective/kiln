/** One item of the breadcrumb in the top bar. The last item is the current page and has no link. */
export type Crumb = { label: string; href: string | null; current: boolean; kind: 'workspace' | 'section' | 'app' };

/**
 * The breadcrumb: workspace, then the section (a link when an app is open), then the app. Empty labels
 * are dropped so the bar never shows a lone separator.
 */
export function breadcrumbItems(input: {
  workspace?: string | null;
  section?: { label: string; href: string } | null;
  appName?: string | null;
  appOpen: boolean;
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
  if (input.appOpen) items.push({ label: (input.appName ?? '').trim() || 'App', href: null, current: true, kind: 'app' });
  return items;
}
