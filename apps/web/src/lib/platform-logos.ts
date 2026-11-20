/**
 * Official platform logos, dropped in by the maintainer. Put `ios.svg`, `macos.svg` and
 * `android.svg` in `src/assets/platforms/` (see docs/design/readability.md for the brand rules);
 * `PlatformBadge` shows the file when it exists and the generic tinted glyph otherwise. This file
 * is pure so it can be tested: the component passes in what `import.meta.glob` found.
 */

/** Modules found by the bundler, keyed by path (for example `../assets/platforms/ios.svg`). */
export type LogoModules = Record<string, string>;

/** The URL of the logo file for a platform (`ios`, `macos`, `android`, any case), or null if none was added. */
export function platformLogoUrl(
  modules: LogoModules,
  platform: string | null | undefined,
): string | null {
  const id = (platform ?? '').toLowerCase();
  if (id !== 'ios' && id !== 'macos' && id !== 'android') return null;
  for (const [path, url] of Object.entries(modules)) {
    const file = path.split('/').pop() ?? '';
    if (file.toLowerCase() === `${id}.svg` && typeof url === 'string' && url !== '') return url;
  }
  return null;
}
