/**
 * The derived tokens of a tint as rows for the app Appearance settings (docs/adr/0068-app-tint.md): what each colour is for, its
 * value and the contrast it was derived to meet, per theme. Pure. The labels are i18n keys of the `app` namespace.
 */
import { k } from '../i18n/t.ts';
import { over, parseColor, ratio } from './contrast.ts';
import type { Rgb } from './oklch.ts';
import { type AppTint, type Scheme, type SchemeTokens, themeSurfaces } from './tokens.ts';

export type TokenRow = {
  id: 'accent' | 'accentInk' | 'accentSolid' | 'tintSubtle';
  labelKey: string;
  /** The minimum the derivation guarantees. */
  min: number;
  /** The colour to show, `#rrggbb` or `#rrggbbaa`. */
  hex: Record<Scheme, string>;
  /** The measured ratio of the pair, per theme. */
  ratio: Record<Scheme, number>;
};

const surfaceOf = (scheme: Scheme): Rgb => themeSurfaces[scheme].backgrounds[2] as Rgb;

function measure(id: TokenRow['id'], t: SchemeTokens, scheme: Scheme): number {
  const surface = surfaceOf(scheme);
  const px = (hex: string): Rgb => parseColor(hex) as Rgb;
  if (id === 'accent') return ratio(px(t.accent), surface);
  if (id === 'accentInk') return ratio(px(t.accentInk), surface);
  if (id === 'accentSolid') return ratio(px(t.onAccent), px(t.accentSolid));
  // Body text on the subtle tint, the weakest of the text colours over it.
  const under = over(
    parseColor(t.tintSubtle) as NonNullable<ReturnType<typeof parseColor>>,
    surface,
  );
  return Math.min(...themeSurfaces[scheme].texts.map((x) => ratio(x.fg, under)));
}

const SPEC: {
  id: TokenRow['id'];
  labelKey: string;
  min: number;
  pick: (t: SchemeTokens) => string;
}[] = [
  { id: 'accent', labelKey: k('app:appearance.token.accent'), min: 3, pick: (t) => t.accent },
  {
    id: 'accentInk',
    labelKey: k('app:appearance.token.accentInk'),
    min: 4.5,
    pick: (t) => t.accentInk,
  },
  {
    id: 'accentSolid',
    labelKey: k('app:appearance.token.accentSolid'),
    min: 4.5,
    pick: (t) => t.accentSolid,
  },
  {
    id: 'tintSubtle',
    labelKey: k('app:appearance.token.tint'),
    min: 4.5,
    pick: (t) => t.tintSubtle,
  },
];

export function tokenRows(tint: AppTint): TokenRow[] {
  return SPEC.map((s) => ({
    id: s.id,
    labelKey: s.labelKey,
    min: s.min,
    hex: { light: s.pick(tint.light), dark: s.pick(tint.dark) },
    ratio: { light: measure(s.id, tint.light, 'light'), dark: measure(s.id, tint.dark, 'dark') },
  }));
}
