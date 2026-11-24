/**
 * The app tint, as the UI reads it (docs/adr/0068-app-tint.md): which apps have a palette, the person's switch, the per-app
 * overrides, and the inline style that carries a tint. `style(appId)` is cheap and reads the cache synchronously, so a screen
 * renders tinted on its very first paint; `track(appId, iconUrl)` makes sure the palette is known (cache, else extraction).
 * No colour is ever invented for an app without a palette: no palette, no tint.
 */
import { type CacheEntry, readEntry, writeEntry } from './cache.ts';
import { paletteFromUrl } from './extract.ts';
import { type AppAppearance, readTintPref, resolveTint, saveTintPref } from './prefs.ts';
import type { Palette } from './palette.ts';
import { createLimiter } from './switcher.ts';
import { type AppTint, tintStyle } from './tokens.ts';

class TintStore {
  /** The person's switch. */
  enabled = $state(readTintPref());
  /** Bumped when a palette or an override changes, so every `style()` read is recomputed. */
  private _version = $state(0);
  private _palettes = new Map<string, CacheEntry>();
  private _cacheRead = new Set<string>();
  private _pending = new Set<string>();
  private _overrides = new Map<string, AppAppearance>();
  private _styles = new Map<string, string>();

  setEnabled(on: boolean): void {
    this.enabled = on;
    saveTintPref(on);
    this._bump();
  }

  /** The workspace's overrides (apps with `auto` are absent). Replaces what was known. */
  setOverrides(all: Record<string, AppAppearance>): void {
    this._overrides = new Map(Object.entries(all));
    this._bump();
  }

  setOverride(appId: string, value: AppAppearance): void {
    if (value.tint === 'auto') this._overrides.delete(appId);
    else this._overrides.set(appId, value);
    this._bump();
  }

  overrideOf(appId: string): AppAppearance {
    void this._version;
    return this._overrides.get(appId) ?? { tint: 'auto' };
  }

  private _bump(): void {
    this._styles.clear();
    this._version += 1;
  }

  private _entry(appId: string): CacheEntry | undefined {
    if (!this._palettes.has(appId) && !this._cacheRead.has(appId)) {
      this._cacheRead.add(appId);
      const cached = readEntry(appId);
      if (cached) this._palettes.set(appId, cached);
    }
    return this._palettes.get(appId);
  }

  paletteOf(appId: string): Palette | null {
    void this._version;
    return this._entry(appId)?.palette ?? null;
  }

  /** The derived tint of an app (null: none). */
  tintOf(appId: string): AppTint | null {
    void this._version;
    return resolveTint({
      enabled: this.enabled,
      appearance: this._overrides.get(appId),
      palette: this._entry(appId)?.palette ?? null,
    });
  }

  /** The inline style for `data-app-tint` (empty: no tint, and then the attribute is left off). */
  style(appId: string): string {
    void this._version;
    const hit = this._styles.get(appId);
    if (hit !== undefined) return hit;
    const style = tintStyle(this.tintOf(appId));
    this._styles.set(appId, style);
    return style;
  }

  /** The style for a colour picked in the settings: the same derivation, so any colour is safe. */
  styleOfColor(color: string): string {
    return tintStyle(resolveTint({ enabled: true, appearance: { tint: 'custom', color } }));
  }

  /** Makes sure the palette of this icon is known: the cache when it names this URL, else a read of the icon. */
  track(appId: string, iconUrl: string | null | undefined): Promise<void> {
    if (!iconUrl) return Promise.resolve();
    const known = this._entry(appId);
    if (known && known.url === iconUrl) return Promise.resolve();
    const key = `${appId}|${iconUrl}`;
    if (this._pending.has(key)) return Promise.resolve();
    this._pending.add(key);
    return paletteFromUrl(iconUrl).then((palette) => {
      this._pending.delete(key);
      if (!palette) return;
      const entry = { url: iconUrl, palette };
      this._palettes.set(appId, entry);
      writeEntry(appId, entry);
      this._bump();
    });
  }

  private _warmer = createLimiter(2);

  /** `track` for a list of rows (the app switcher): two reads at a time, each icon once, so opening a long list never floods the page. */
  warm(appId: string, iconUrl: string | null | undefined): void {
    if (!iconUrl || !this.enabled) return;
    const known = this._entry(appId);
    if (known && known.url === iconUrl) return;
    this._warmer(`${appId}|${iconUrl}`, () => this.track(appId, iconUrl));
  }
}

export const tint = new TintStore();
