/**
 * The app filter of the reviews inbox (docs/ux-ia.md "Reviews"): the pure view-model behind the multi-select combobox
 * (components/reviews/AppFilter.svelte). The state is `InboxFilters.appIds`, kept in the address as `?apps=id1,id2` (reviews.ts
 * `inboxFiltersToSearch` / `inboxFiltersFromSearch`, combinable with every other filter) and sent to the server as `appIds`.
 * Written for the ES2017 web build; no DOM.
 */
import type { Platform } from '@kiln/core';
import { t } from '../i18n/t.ts';
import { type InboxFilters, type SummaryApp, toggleIn } from './reviews.ts';

export type AppOption = {
  id: string;
  name: string;
  /** The bundle id or package name, searched too. */
  identifier: string;
  platform: Platform;
  iconUrl: string | null;
  /** Stored reviews of the app, and the new ones; null until the summary is read. */
  total: number | null;
  newCount: number | null;
};

type AppLike = { id: string; name: string; identifier: string; platform: Platform; iconUrl?: string | null | undefined };

/** The apps the person can see, with their counts from the summary (`GET /reviews/summary`), by name. */
export function appOptions(apps: readonly AppLike[], summary: readonly SummaryApp[] | null | undefined): AppOption[] {
  const counts = new Map((summary ?? []).map((s) => [s.app.id, s] as const));
  return apps
    .map((a) => {
      const c = counts.get(a.id);
      return {
        id: a.id,
        name: a.name,
        identifier: a.identifier,
        platform: a.platform,
        iconUrl: a.iconUrl ?? null,
        total: c ? c.total : null,
        newCount: c ? c.new : null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name) || x.identifier.localeCompare(y.identifier) || x.id.localeCompare(y.id));
}

/** Options whose name or bundle id contains the words typed (case and accents ignored, every word must match). */
export function matchApps(options: readonly AppOption[], query: string): AppOption[] {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [...options];
  return options.filter((o) => {
    const hay = `${fold(o.name)} ${fold(o.identifier)}`;
    return words.every((w) => hay.includes(w));
  });
}

/** The ids with this one added or removed. */
export const toggleApp = (ids: readonly string[], id: string): string[] => toggleIn(ids, id);

export const removeApp = (ids: readonly string[], id: string): string[] => ids.filter((x) => x !== id);

/** "All apps": the reset. */
export const allApps = (): string[] => [];

/** The chosen options, in the order they were chosen; an id that is not a visible app is not a chip. */
export function selectedOptions(options: readonly AppOption[], ids: readonly string[]): AppOption[] {
  const byId = new Map(options.map((o) => [o.id, o] as const));
  return ids.map((id) => byId.get(id)).filter((o): o is AppOption => o !== undefined);
}

/**
 * Ids of the address that are not apps this person can see (another workspace, a deleted app, a token limited to other apps) are dropped,
 * so a shared link never shows a phantom chip and never asks the server for an app the person cannot see. Only once the apps are known.
 */
export function pruneAppIds(ids: readonly string[], options: readonly AppOption[], known: boolean): string[] {
  if (!known) return [...ids];
  const visible = new Set(options.map((o) => o.id));
  return ids.filter((id) => visible.has(id));
}

/** The reviews in the list for these apps: the counts of the chosen apps added up (null while unknown). */
export function chosenTotal(options: readonly AppOption[], ids: readonly string[]): number | null {
  const chosen = selectedOptions(options, ids);
  if (chosen.length === 0 || chosen.some((o) => o.total === null)) return null;
  return chosen.reduce((sum, o) => sum + (o.total ?? 0), 0);
}

/** How many filters other than the apps are on (the summary line says "and N more filters"). */
export function otherFilterCount(f: InboxFilters): number {
  return [
    f.platform !== '',
    f.ratings.length > 0,
    f.statuses.length > 0,
    f.response !== '',
    f.assignee !== '',
    f.version.trim() !== '',
    f.territory.trim() !== '',
    f.language.trim() !== '',
    f.q.trim() !== '',
    f.within !== '',
  ].filter(Boolean).length;
}

/** One line for the active filters, or null when none: `Reviews of Alpha and Beta, with 2 more filters.` */
export function filterSummaryText(f: InboxFilters, options: readonly AppOption[]): string | null {
  const names = selectedOptions(options, f.appIds).map((o) => o.name);
  const others = otherFilterCount(f);
  if (names.length === 0 && others === 0) return null;
  const apps =
    names.length === 0
      ? ''
      : names.length <= 2
        ? names.join(t('reviews:appFilter.and'))
        : t('reviews:appFilter.nameAndMore', { name: names[0] ?? '', count: names.length - 1 });
  if (names.length === 0) return t('reviews:appFilter.summaryOthers', { count: others });
  return others === 0
    ? t('reviews:appFilter.summaryApps', { apps })
    : t('reviews:appFilter.summaryAppsOthers', { apps, count: others });
}

/** The words of the listbox's live region: how many apps match what was typed. */
export const matchCountText = (count: number): string => t('reviews:appFilter.matches', { count });
