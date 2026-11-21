import type { Action, Platform } from '@kiln/core';
import type { AppGroup } from './app-groups.ts';
import { canonicalAppHash, canonicalSection, sectionViews } from './app-nav.ts';
import {
  type AppSection,
  appAddress,
  isPlatformScope,
  parseAppAddress,
  parseViewPath,
  visibleSections,
} from './app-scope.ts';
import type { PendingLine } from './pending.ts';

/**
 * The searchable app switcher (Cmd or Ctrl + K) as pure functions. One item per app (the iOS, macOS and
 * Android records of one product are one item). The first nine carry a number: Cmd or Ctrl + that digit
 * jumps straight to the app, so the number belongs to the app and does not change while searching.
 */

export type SwitcherItem = {
  /** The id of the app's first record: what the address uses. */
  key: string;
  /** The ids of every record of the app (iOS, macOS, Android): the address may name any of them. */
  ids: string[];
  /** The icon route of the first record that has one, or null (the tile shows initials). */
  iconUrl: string | null;
  name: string;
  /** The bundle ids and package names, shown under the name, so apps with one name can be told apart. */
  identifiers: string[];
  platforms: Platform[];
  /** 1 to 9 for the first nine apps, else null. */
  number: number | null;
  /** What is pending for the app (the chip in the list); absent or null draws nothing. Set by the shell from the pending summary. */
  pending?: PendingLine | null;
};

export const SWITCHER_NUMBERS = 9;

export function switcherItems(groups: readonly AppGroup[]): SwitcherItem[] {
  return groups.map((g, i) => ({
    key: g.key,
    ids: g.members.map((m) => m.id),
    iconUrl: g.members.map((m) => m.iconUrl ?? null).find((u) => u) ?? null,
    name: g.name,
    identifiers: [...new Set(g.members.map((m) => m.identifier))],
    platforms: g.platforms,
    number: i < SWITCHER_NUMBERS ? i + 1 : null,
  }));
}

/** The app for Cmd or Ctrl + digit (0 based index), or null when there are fewer apps. */
export const jumpTarget = (items: readonly SwitcherItem[], index: number): SwitcherItem | null =>
  index >= 0 && index < SWITCHER_NUMBERS ? (items[index] ?? null) : null;

const norm = (text: string): string => text.toLowerCase();

/** 0 best. Substring at the start of a word beats one inside it; letters in order (a subsequence) come last. */
function score(text: string, token: string): number | null {
  const t = norm(text);
  const at = t.indexOf(token);
  if (at === 0) return 0;
  if (at > 0) return /[^a-z0-9]/.test(t.charAt(at - 1)) ? 1 : 2;
  let i = 0;
  for (const ch of t) if (ch === token.charAt(i)) i += 1;
  return i === token.length && token.length >= 2 ? 4 : null;
}

/**
 * The items that match every word of the query, in the order of the best match. An empty query keeps
 * the list as it is. A word may match the name (best) or an identifier.
 */
export function filterSwitcher(items: readonly SwitcherItem[], query: string): SwitcherItem[] {
  const tokens = norm(query)
    .split(/\s+/)
    .filter((t) => t !== '');
  if (tokens.length === 0) return [...items];
  const ranked: { item: SwitcherItem; total: number; at: number }[] = [];
  items.forEach((item, at) => {
    let total = 0;
    for (const token of tokens) {
      const byName = score(item.name, token);
      const byId = item.identifiers
        .map((id) => score(id, token))
        .filter((s): s is number => s !== null);
      const best = Math.min(byName ?? Infinity, ...byId.map((s) => s + 2));
      if (best === Infinity) return;
      total += best;
    }
    ranked.push({ item, total, at });
  });
  return ranked.sort((a, b) => a.total - b.total || a.at - b.at).map((r) => r.item);
}

/** The item an address names (its id may be any record of the app), or null. */
export const itemOfId = (items: readonly SwitcherItem[] | null, id: string): SwitcherItem | null =>
  items?.find((i) => i.ids.indexOf(id) >= 0) ?? null;

/**
 * The highlighted row after a key, for the list of the Cmd or Ctrl + K dialog and the field in the left panel
 * (one rule for both). Home and End jump; other keys leave the row as it is.
 */
export function moveActive(key: string, current: number, count: number): number {
  if (count <= 0) return 0;
  if (key === 'ArrowDown') return Math.min(count - 1, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return Math.min(Math.max(0, current), count - 1);
}

/**
 * Where another app opens: on the same page the current app shows (Releases stays Releases, Store listing stays Store listing), not on
 * its Overview. The generic parts of the address come along when they are valid there: the view (`?view=`, unless it is Search terms
 * and the app has no Google Play record) and the platform scope (when the app has that platform, else all of them). The version, the
 * locale and an open release belong to the old app and are dropped. A page the person may not open falls back to the Overview. From
 * anywhere that is not an app (All apps, the inbox) the app opens on its Overview, as before.
 */
export function appSwitchHash(
  currentHash: string,
  target: Pick<SwitcherItem, 'key' | 'platforms'>,
  allowed: (action: Action) => boolean = () => true,
): string {
  const hash = canonicalAppHash(currentHash) ?? currentHash;
  const here = parseAppAddress(hash);
  if (!here) return appAddress(target.key);
  const section: AppSection = canonicalSection(here.section);
  const open = visibleSections(allowed).some((s) => s.id === section);
  if (!open || section === 'dashboard')
    return appAddress(target.key, 'dashboard', scopeFor(here.platform, target.platforms));
  const base = appAddress(target.key, section, scopeFor(here.platform, target.platforms));
  // An open release is a version of the old app: the list of the new one opens.
  const params = new URLSearchParams();
  const view = here.release === null ? parseViewPath(hash).query.get('view') : null;
  const views = sectionViews[section];
  if (view !== null && views && (section === 'insights' || views.some((v) => v.id === view))) {
    const entry = views.find((v) => v.id === view);
    const playOnly = entry?.androidOnly === true && target.platforms.indexOf('android') < 0;
    const allowedView = entry?.requires === undefined || allowed(entry.requires);
    if (!playOnly && allowedView) params.set('view', view);
  }
  const search = params.toString();
  if (search === '') return base;
  return base.indexOf('?') < 0 ? `${base}?${search}` : `${base}&${search}`;
}

/** The platform scope of the address when the other app has it, else none (all of its platforms). */
function scopeFor(asked: string | null, platforms: readonly Platform[]): 'both' | Platform | null {
  if (!isPlatformScope(asked)) return null;
  if (asked === 'both') return platforms.length > 1 ? 'both' : null;
  return platforms.indexOf(asked) >= 0 ? asked : null;
}
