/**
 * Pure helpers of the store graphics viewer (components/assets/StoreImageViewer.svelte): which image an arrow key shows, the name a
 * saved file gets, and how an image is put on the clipboard. The browser parts (fetch, canvas, clipboard) live in the component.
 */

/** The index after an arrow key, staying inside the set (no wrap round). */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

const EXTENSION_OF: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** `name` (the file's original name) when it has one, else `<locale>-<set>-<position>`; always with the extension of the bytes. */
export function downloadName(input: {
  name: string | null | undefined;
  locale: string;
  setName: string;
  position: number;
  mime: string;
}): string {
  const ext = EXTENSION_OF[input.mime.toLowerCase()] ?? 'png';
  const raw = (input.name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._ -]+/g, '_')
      .replace(/^\.+/, '')
      .trim();
  const dot = raw.lastIndexOf('.');
  const stem = clean(dot > 0 ? raw.slice(0, dot) : raw);
  const base =
    stem !== ''
      ? stem
      : clean(`${input.locale}-${input.setName}-${input.position}`.replace(/\s+/g, '-'));
  return `${base === '' ? 'image' : base}.${ext}`;
}

/**
 * How to put an image on the clipboard: browsers take `image/png` only, so a PNG goes as it is, any other format is drawn to a PNG
 * first, and without the async clipboard for images the person is given the file to save instead.
 */
export function clipboardPlan(supportsImages: boolean, mime: string): 'png' | 'convert' | 'save' {
  if (!supportsImages) return 'save';
  return mime.toLowerCase() === 'image/png' ? 'png' : 'convert';
}

/** `1242 × 2688`, or '' when a side is unknown. */
export const pixelText = (width: number | null, height: number | null): string =>
  width !== null && height !== null ? `${width} × ${height}` : '';
