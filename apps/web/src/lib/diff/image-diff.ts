/**
 * Image comparison, pure (docs/adr/0067-diff-and-preview.md): the pairs a viewer steps through, the state of a pair, and the cheap
 * "changed pixels" estimate on a downscaled canvas. No DOM and no fetch: the component draws the canvas and passes the pixel arrays.
 * Addresses are always the server's own (`/api/...` image routes: store thumbnail proxy, staged blob, repository file); a client
 * never loads an external address (CSP `img-src 'self' data:`, docs/adr/0049-testflight-feedback.md).
 */

export type ImageSide = {
  /** A same origin address, or null when there is no image on this side. */
  url: string | null;
  width?: number | null | undefined;
  height?: number | null | undefined;
  bytes?: number | null | undefined;
  name?: string | null | undefined;
};
export type ImagePair = {
  key: string;
  title: string;
  subtitle?: string | undefined;
  before: ImageSide | null;
  after: ImageSide | null;
};
export type PairState = 'changed' | 'new' | 'removed' | 'none';

export const MODES = ['side', 'swipe', 'fade', 'difference'] as const;
export type ImageMode = (typeof MODES)[number];

/** The longest side of the canvas that the changed pixel estimate is drawn on. */
export const PIXEL_CAP = 512;
/** Channel difference (0 to 255) below which a pixel counts as unchanged (encoders and scaling jitter). */
export const PIXEL_TOLERANCE = 16;

export const hasImage = (s: ImageSide | null | undefined): s is ImageSide =>
  !!s && s.url !== null && s.url !== '';

/** `new`: nothing before (a new asset), `removed`: nothing after, `changed`: both, `none`: neither. */
export function pairState(pair: Pick<ImagePair, 'before' | 'after'>): PairState {
  const b = hasImage(pair.before);
  const a = hasImage(pair.after);
  return b && a ? 'changed' : a ? 'new' : b ? 'removed' : 'none';
}

/** Pair two ordered lists by position (the 1st with the 1st, ...): a longer side leaves the rest new or removed. */
export function pairByPosition(
  before: readonly ImageSide[],
  after: readonly ImageSide[],
  title: (position: number) => string,
  keyPrefix = '',
): ImagePair[] {
  const n = Math.max(before.length, after.length);
  return Array.from({ length: n }, (_, i) => ({
    key: `${keyPrefix}${i + 1}`,
    title: title(i + 1),
    before: before[i] ?? null,
    after: after[i] ?? null,
  }));
}

/** The size of a canvas that holds an image of `width` x `height` with its longest side at most `cap`; never zero. */
export function canvasSize(
  width: number,
  height: number,
  cap = PIXEL_CAP,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const k = Math.min(1, cap / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Whether two images have the same shape (aspect ratio within 1%), so a pixel by pixel estimate means something. */
export function sameShape(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return Math.abs(a.width / a.height - b.width / b.height) / (a.width / a.height) <= 0.01;
}

/**
 * The share of pixels (0 to 1) whose largest channel difference is over `tolerance`, from two RGBA arrays of the same length.
 * Returns null when the arrays differ in length or are empty.
 */
export function changedRatio(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tolerance = PIXEL_TOLERANCE,
): number | null {
  if (a.length !== b.length || a.length === 0 || a.length % 4 !== 0) return null;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
      Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0)),
    );
    if (d > tolerance) changed++;
  }
  return changed / (a.length / 4);
}

/** A whole percent for the hint: 0 only when nothing changed, at least 1 otherwise, at most 100. */
export const percentText = (ratio: number): number =>
  ratio <= 0 ? 0 : Math.min(100, Math.max(1, Math.round(ratio * 100)));

export const clampPercent = (n: number): number =>
  Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50;

/** `1242 x 2688 px` (with a multiplication sign) or '' when unknown. */
export const dimensionsText = (
  s: Pick<ImageSide, 'width' | 'height'> | null | undefined,
): string => (s && s.width && s.height ? `${s.width} × ${s.height} px` : '');
