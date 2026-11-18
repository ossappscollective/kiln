/**
 * Pure helpers of the app icon (components/ui/AppIcon.svelte, docs/api/assets.md): which image URL
 * is safe to load, the initials and tint of the fallback tile, the sizes and the accessible name.
 * No DOM. Written for the ES2017 target of the web build.
 */

export type AppIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Side of the square in pixels. The tile always has this size, so a late icon never shifts a layout. */
export const APP_ICON_PX: Record<AppIconSize, number> = { xs: 20, sm: 24, md: 32, lg: 48, xl: 64 };

export function appIconPixels(size: AppIconSize | number): number {
  return typeof size === 'number' ? Math.max(12, Math.round(size)) : APP_ICON_PX[size] ?? APP_ICON_PX.md;
}

/**
 * The URL to load an icon from, or null. Only the icon route of this server is accepted (a path
 * under /api/workspaces/, same origin): the web app never loads an image from another host, and a
 * value that is not a plain path (a scheme, `//host`, a backslash, `..`, a control character) is
 * dropped, so a wrong or hostile value can only ever give the fallback tile.
 */
export function iconSrc(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('/api/workspaces/')) return null;
  if (url.length > 600) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(url)) return null;
  const path = url.split('?')[0] as string;
  if (path.split('/').some((part) => part === '..' || part === '.')) return null;
  if (url.includes('//')) return null;
  return url;
}

/** A character that can be shown in the tile: not white space and not ASCII punctuation (any other script counts). */
const isGlyph = (ch: string) => !/[\s!-/:-@[-`{-~]/.test(ch);

/** One or two letters for the fallback tile: the first letters of the first two words, else the first two letters. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/[\s\-_.]+/)
    .map((w) => Array.from(w).filter(isGlyph))
    .filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  const [first, second] = words as [string[], string[]?];
  const text = second ? (first[0] as string) + (second[0] as string) : first.slice(0, 2).join('');
  return text.toUpperCase();
}

export const APP_ICON_TINTS = 4;

/** A stable number below `APP_ICON_TINTS` from a seed (an app id or name), so an app keeps its tile color. */
export function tintIndex(seed: string | null | undefined): number {
  const text = seed ?? '';
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 1000003;
  return hash % APP_ICON_TINTS;
}

/**
 * The text alternative. When the app's name is written next to the icon the icon is decorative
 * (an empty alt); alone it names the app.
 */
export function iconAlt(name: string | null | undefined, labelled: boolean): string {
  if (labelled) return '';
  const n = (name ?? '').trim();
  return n === '' ? 'App icon' : `${n} icon`;
}
