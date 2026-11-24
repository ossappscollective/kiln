/**
 * The left panel can fold to a rail of icons. The choice is remembered per person in this browser (localStorage, never required:
 * every access is in try/catch, so a blocked or full store just means the panel opens wide). The pure parts are here so they can be
 * tested; the Shell owns the reactive state.
 */

export const SIDEBAR_STORAGE_PREFIX = 'kiln.sidebar.collapsed';

/** One key per person, so two people on one browser keep their own choice. */
export const sidebarStorageKey = (userId: string): string => `${SIDEBAR_STORAGE_PREFIX}.${userId}`;

/** The stored text as a choice; anything unknown is "not chosen" (null). */
export function parseCollapsed(raw: string | null | undefined): boolean | null {
  return raw === '1' ? true : raw === '0' ? false : null;
}

type StoreLike = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): StoreLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The remembered choice of this person, or `fallback` (also when storage cannot be read). */
export function loadCollapsed(
  userId: string,
  fallback = false,
  store: StoreLike | null = defaultStore(),
): boolean {
  try {
    return parseCollapsed(store?.getItem(sidebarStorageKey(userId))) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the choice; a failure (private mode, quota) is ignored. */
export function saveCollapsed(
  userId: string,
  collapsed: boolean,
  store: StoreLike | null = defaultStore(),
): void {
  try {
    store?.setItem(sidebarStorageKey(userId), collapsed ? '1' : '0');
  } catch {
    // Not remembered; the panel still folds for this visit.
  }
}

/** The rail only exists beside the page: on a narrow screen the panel is a drawer and is always shown whole. */
export const railApplies = (collapsed: boolean, wide: boolean): boolean => collapsed && wide;
