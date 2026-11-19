import {
  type AssetSlot,
  extensionForFormat,
  type FixKind,
  nearestRequiredSize,
  type Platform,
  readImageHeader,
  requiredSizesText,
  type Size,
  sniffImageFormat,
} from '@mrm/core';
import { decodePng, encodePng, flatten, hasTransparentPixels, resizeCover } from './png-codec.ts';

/**
 * The fixes of the Assets tab (docs/adr/0012-assets-two-way-sync.md): a corrected COPY of a file, never a change in place. Pure.
 *
 * - `remove_alpha`: composites the image on a background colour (white by default) and writes an 8 bit RGB PNG.
 * - `rename_extension`: the content is one format and the name says another; the bytes stay, the name changes.
 * - `resize`: PNG only, to the nearest size the store requires (cropped from the centre when the aspect ratio differs).
 *
 * What cannot be done here (a JPEG or WebP to be re-encoded, a 16 bit or interlaced PNG, a size the store only states as a
 * range) is refused with the reason and, for a size, the exact sizes that are required.
 */

export type FixInput = {
  platform: Platform;
  slot: AssetSlot;
  /** The file name (a base name). */
  name: string;
  bytes: Uint8Array;
  kind: FixKind;
  /** `remove_alpha`: the background as `[r, g, b]` (0 to 255). Default white. */
  background?: readonly [number, number, number] | undefined;
};

export type FixOutput = {
  ok: true;
  bytes: Uint8Array;
  name: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  hasAlpha: boolean;
  /** One sentence for the person: what was done. */
  summary: string;
};

export type FixFailure = {
  ok: false;
  code:
    | 'not_png'
    | 'unsupported'
    | 'corrupt'
    | 'too_large'
    | 'nothing_to_fix'
    | 'no_target_size'
    | 'bad_input';
  message: string;
};

const swapExtension = (name: string, ext: string): string => {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
};

export const parseHexColour = (value: string): [number, number, number] | undefined => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function fixImage(input: FixInput): FixOutput | FixFailure {
  const sniffed = sniffImageFormat(input.bytes);
  if (input.kind === 'rename_extension') {
    const right = sniffed === null ? undefined : extensionForFormat(sniffed);
    if (sniffed === null || right === undefined)
      return {
        ok: false,
        code: 'unsupported',
        message: 'The file is not a PNG, JPEG, WebP or GIF, so there is no right extension for it.',
      };
    const dot = input.name.lastIndexOf('.');
    const have = dot > 0 ? input.name.slice(dot + 1).toLowerCase() : '';
    if (have === right)
      return { ok: false, code: 'nothing_to_fix', message: `The name already ends in .${right}.` };
    const header = readImageHeader(input.bytes);
    if (!header.ok || (sniffed !== 'png' && sniffed !== 'jpeg'))
      return {
        ok: false,
        code: 'unsupported',
        message:
          'Only PNG and JPEG files are uploaded to the stores, so renaming a file of another format does not help.',
      };
    return {
      ok: true,
      bytes: input.bytes,
      name: swapExtension(input.name, right),
      format: sniffed,
      width: header.width,
      height: header.height,
      hasAlpha: header.hasAlpha === true,
      summary: `Renamed to .${right}: the content is ${sniffed.toUpperCase()}.`,
    };
  }
  if (sniffed !== 'png') {
    return {
      ok: false,
      code: 'not_png',
      message: `This is ${sniffed === null ? 'not an image this server knows' : `a ${sniffed.toUpperCase()}`}. Only PNG files can be changed here: export the image again from the tool that made it.`,
    };
  }
  const decoded = decodePng(input.bytes);
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
  const { raster, meta } = decoded;
  if (input.kind === 'remove_alpha') {
    if (!meta.hadAlpha)
      return {
        ok: false,
        code: 'nothing_to_fix',
        message: 'This PNG has no alpha channel or transparency.',
      };
    const bg = input.background ?? [255, 255, 255];
    const flat = flatten(raster, bg);
    return {
      ok: true,
      bytes: encodePng(flat, meta.keep),
      name: swapExtension(input.name, 'png'),
      format: 'png',
      width: flat.width,
      height: flat.height,
      hasAlpha: false,
      summary: `Removed the alpha channel: ${hasTransparentPixels(raster) ? 'transparent areas are now' : 'the file is now an RGB PNG on'} #${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}.`,
    };
  }
  // resize
  const target = nearestRequiredSize(input.platform, input.slot, raster.width, raster.height);
  if (target === null) {
    return {
      ok: false,
      code: 'no_target_size',
      message: `There is no exact size to resize to. ${requiredSizesText(input.platform, input.slot)}.`,
    };
  }
  if (target.width === raster.width && target.height === raster.height)
    return { ok: false, code: 'nothing_to_fix', message: 'The image already has a required size.' };
  // The decoder always gives four channels: an image with no transparent pixel stays an RGB PNG, so a resize never adds an alpha channel.
  const base = hasTransparentPixels(raster) ? raster : flatten(raster, [255, 255, 255]);
  const resized = resizeCover(base, target.width, target.height);
  const aspectChanged =
    Math.abs(raster.width / raster.height - target.width / target.height) > 0.002;
  return {
    ok: true,
    bytes: encodePng(resized, meta.keep),
    name: swapExtension(input.name, 'png'),
    format: 'png',
    width: resized.width,
    height: resized.height,
    hasAlpha: resized.channels === 4,
    summary: `Resized from ${raster.width} x ${raster.height} to ${(target as Size).width} x ${(target as Size).height}${aspectChanged ? ' (cropped from the centre to keep the proportions)' : ''}.`,
  };
}
