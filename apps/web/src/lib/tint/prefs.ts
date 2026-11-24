/**
 * The two choices behind the app tint (docs/adr/0068-app-tint.md): the person's own switch (default on, kept in localStorage like
 * the theme) and the per-app override stored in the workspace (`auto`, `off`, `custom`), and what they make of a palette.
 */
import type { Palette } from './palette.ts';
import { type AppTint, deriveTint } from './tokens.ts';

export const TINT_PREF_KEY = 'kiln.tint';

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem' | 'removeItem'>;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** On unless the person turned it off. An unreadable store is "on" (the default). */
export function readTintPref(storage: Reader | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(TINT_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveTintPref(on: boolean, storage: Writer | undefined = defaultStorage()): void {
  try {
    if (on) storage?.removeItem(TINT_PREF_KEY);
    else storage?.setItem(TINT_PREF_KEY, 'off');
  } catch {
    // Not remembered: the choice lasts until the page is closed.
  }
}

/** The per-app choice, as the server stores it. */
export type AppAppearance = { tint: 'auto' | 'off' | 'custom'; color?: string };

/** Where the colour picker starts when a person chooses Custom for the first time. */
export const DEFAULT_CUSTOM_COLOR = '#3b82f6';

export const AUTO_APPEARANCE: AppAppearance = { tint: 'auto' };

const COLOR = /^#[0-9a-fA-F]{6}$/;

export const isColor = (value: string): boolean => COLOR.test(value);

/**
 * The tint of one app, or null for none (the default accent stays). Order: the person's switch, then the app's override, then
 * the icon: the primary colour of its palette, else the secondary when the primary could not be made safe.
 */
export function resolveTint(input: {
  enabled: boolean;
  appearance?: AppAppearance | undefined;
  palette?: Palette | null | undefined;
}): AppTint | null {
  if (!input.enabled) return null;
  const a = input.appearance ?? AUTO_APPEARANCE;
  if (a.tint === 'off') return null;
  if (a.tint === 'custom') return a.color && isColor(a.color) ? deriveTint(a.color) : null;
  const p = input.palette;
  if (!p || p.neutral) return null;
  for (const color of p.colors.slice(0, 2)) {
    const tint = deriveTint(color);
    if (tint) return tint;
  }
  return null;
}
