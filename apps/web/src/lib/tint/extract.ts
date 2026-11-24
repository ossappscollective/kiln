/**
 * Reads an app icon into a palette in the browser (docs/adr/0068-app-tint.md): the image is loaded from this server (the URL is
 * checked by iconSrc, so only the icon route is ever requested, CSP img-src 'self'), drawn on a 32 by 32 canvas, and the pixels
 * go to extractPalette. Null when the image cannot be loaded or read: no tint, never an error shown to a person.
 * DOM only; the maths is palette.ts.
 */
import { iconSrc } from '../app-icon.ts';
import { extractPalette, type Palette } from './palette.ts';

export const SAMPLE_SIZE = 32;

export function paletteFromUrl(url: string | null | undefined): Promise<Palette | null> {
  const src = iconSrc(url);
  if (src === null || typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        resolve(extractPalette(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
