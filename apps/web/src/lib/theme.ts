/** Theme preference: follow the system (auto), or force light or dark. Remembered in localStorage. */

export const themePrefs = ['auto', 'light', 'dark'] as const;
export type ThemePref = (typeof themePrefs)[number];

export const THEME_KEY = 'kiln.theme';

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem' | 'removeItem'>;

export function parseThemePref(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The saved preference, or `auto` when nothing is saved or storage is unavailable. */
export function readThemePref(storage: Reader | undefined = defaultStorage()): ThemePref {
  try {
    return parseThemePref(storage?.getItem(THEME_KEY));
  } catch {
    return 'auto';
  }
}

/** Saves the preference. A private window can refuse storage; the choice then lasts one visit. */
export function saveThemePref(
  pref: ThemePref,
  storage: Writer | undefined = defaultStorage(),
): void {
  try {
    if (pref === 'auto') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, pref);
  } catch {
    // Not remembered. Nothing else to do.
  }
}

/** Sets or clears `data-theme` on the root element. `auto` leaves the choice to the system. */
export function applyThemePref(
  pref: ThemePref,
  root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void },
): void {
  if (pref === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

const listeners = new Set<(pref: ThemePref) => void>();
let current: ThemePref = 'auto';

const root = () => (typeof document === 'undefined' ? undefined : document.documentElement);

/** Reads the saved preference and applies it. Call once at startup. */
export function initTheme(): ThemePref {
  current = readThemePref();
  const el = root();
  if (el) applyThemePref(current, el);
  return current;
}

export function getThemePref(): ThemePref {
  return current;
}

export function setThemePref(pref: ThemePref): void {
  current = pref;
  const el = root();
  if (el) applyThemePref(pref, el);
  saveThemePref(pref);
  for (const fn of listeners) fn(pref);
}

/** Calls `fn` whenever the preference changes. Returns the unsubscribe function. */
export function onThemePref(fn: (pref: ThemePref) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
