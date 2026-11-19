/**
 * Checks for icon markup, with no dependencies and no DOM: a tokenizer for the SVG path `d`
 * grammar, a bounding box for paths, circles and rects, and the rules an icon must meet. Used by
 * icons.test.ts and scripts/check-icons.ts. A path that fails here is not drawn by anything: fix
 * the data, do not relax the rule.
 */

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

export type Segment = { cmd: string; args: number[] };

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/** Splits path data into commands with their numbers. Throws a readable error on anything invalid. */
export function parsePath(d: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i] as string)) i++;
  };
  skip();
  if (i >= d.length) throw new Error('empty path');
  if (!/[Mm]/.test(d[i] as string)) throw new Error('a path must start with M');
  while (i < d.length) {
    skip();
    if (i >= d.length) break;
    const cmd = d[i] as string;
    const need = ARGS[cmd.toLowerCase()];
    if (need === undefined || !/[A-Za-z]/.test(cmd)) throw new Error(`unexpected "${cmd}" at ${i}`);
    i++;
    if (need === 0) {
      out.push({ cmd, args: [] });
      continue;
    }
    let groups = 0;
    for (;;) {
      skip();
      if (i >= d.length || /[A-Za-z]/.test(d[i] as string)) break;
      const args: number[] = [];
      for (let k = 0; k < need; k++) {
        skip();
        const isFlag = cmd.toLowerCase() === 'a' && (k === 3 || k === 4);
        if (isFlag) {
          const c = d[i];
          if (c !== '0' && c !== '1') throw new Error(`arc flag must be 0 or 1 at ${i}`);
          args.push(Number(c));
          i++;
          continue;
        }
        const m = NUMBER.exec(d.slice(i));
        if (!m) throw new Error(`expected a number at ${i} in "${d.slice(i, i + 12)}"`);
        args.push(Number(m[0]));
        i += m[0].length;
      }
      out.push({ cmd: groups === 0 ? cmd : cmd === 'M' ? 'L' : cmd === 'm' ? 'l' : cmd, args });
      groups++;
    }
    if (groups === 0) throw new Error(`"${cmd}" has no numbers`);
  }
  return out;
}

const empty = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const add = (box: Box, x: number, y: number) => {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
};

function arcPoints(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  fa: number,
  fs: number,
  x2: number,
  y2: number,
): Array<[number, number]> {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const th1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  if (fs && dth < 0) dth += 2 * Math.PI;
  const pts: Array<[number, number]> = [];
  const steps = 48;
  for (let k = 1; k <= steps; k++) {
    const t = th1 + (dth * k) / steps;
    pts.push([
      cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
      cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
    ]);
  }
  return pts;
}

export type PathInfo = { box: Box; subpaths: number; closedSubpaths: number };

/** The bounding box of the drawn curve (curves are sampled, not bounded by control points) and how many subpaths are closed. */
export function pathInfo(d: string): PathInfo {
  const box = empty();
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: [number, number] | null = null; // previous cubic control point, for S
  let lastQ: [number, number] | null = null; // previous quadratic control point, for T
  let subpaths = 0;
  let closedSubpaths = 0;
  let open = false;
  const bez = (pts: Array<[number, number]>) => {
    for (let k = 1; k <= 24; k++) {
      const t = k / 24;
      let q = pts;
      while (q.length > 1) {
        const next: Array<[number, number]> = [];
        for (let j = 0; j < q.length - 1; j++) {
          const a = q[j] as [number, number];
          const b = q[j + 1] as [number, number];
          next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
        q = next;
      }
      add(box, (q[0] as [number, number])[0], (q[0] as [number, number])[1]);
    }
  };
  for (const { cmd, args } of parsePath(d)) {
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    switch (c) {
      case 'm':
        x = (args[0] as number) + ox;
        y = (args[1] as number) + oy;
        sx = x;
        sy = y;
        subpaths++;
        open = true;
        add(box, x, y);
        break;
      case 'l':
        x = (args[0] as number) + ox;
        y = (args[1] as number) + oy;
        add(box, x, y);
        break;
      case 'h':
        x = (args[0] as number) + ox;
        add(box, x, y);
        break;
      case 'v':
        y = (args[0] as number) + oy;
        add(box, x, y);
        break;
      case 'c': {
        const p1: [number, number] = [(args[0] as number) + ox, (args[1] as number) + oy];
        const p2: [number, number] = [(args[2] as number) + ox, (args[3] as number) + oy];
        const p3: [number, number] = [(args[4] as number) + ox, (args[5] as number) + oy];
        bez([[x, y], p1, p2, p3]);
        nextC = p2;
        [x, y] = p3;
        break;
      }
      case 's': {
        const p1: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const p2: [number, number] = [(args[0] as number) + ox, (args[1] as number) + oy];
        const p3: [number, number] = [(args[2] as number) + ox, (args[3] as number) + oy];
        bez([[x, y], p1, p2, p3]);
        nextC = p2;
        [x, y] = p3;
        break;
      }
      case 'q': {
        const p1: [number, number] = [(args[0] as number) + ox, (args[1] as number) + oy];
        const p2: [number, number] = [(args[2] as number) + ox, (args[3] as number) + oy];
        bez([[x, y], p1, p2]);
        nextQ = p1;
        [x, y] = p2;
        break;
      }
      case 't': {
        const p1: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const p2: [number, number] = [(args[0] as number) + ox, (args[1] as number) + oy];
        bez([[x, y], p1, p2]);
        nextQ = p1;
        [x, y] = p2;
        break;
      }
      case 'a': {
        const ex = (args[5] as number) + ox;
        const ey = (args[6] as number) + oy;
        for (const [px, py] of arcPoints(
          x,
          y,
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          ex,
          ey,
        ))
          add(box, px, py);
        x = ex;
        y = ey;
        break;
      }
      case 'z':
        x = sx;
        y = sy;
        if (open) closedSubpaths++;
        open = false;
        break;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return { box, subpaths, closedSubpaths };
}

// ---------------------------------------------------------------------------------------------
// Whole icon bodies

export type Shape =
  | { tag: 'path'; d: string }
  | { tag: 'circle'; cx: number; cy: number; r: number }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number };

const ALLOWED: Record<string, string[]> = {
  path: ['d', 'stroke-width', 'fill'],
  circle: ['cx', 'cy', 'r', 'stroke-width', 'fill'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'stroke-width', 'fill'],
};

/** Reads an icon body into shapes. Throws if it holds anything but the allowed elements and attributes. */
export function parseBody(body: string): Shape[] {
  const shapes: Shape[] = [];
  const re = /<(path|circle|rect)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/>/g;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (body.slice(last, m.index).trim() !== '')
      throw new Error(`unexpected markup before index ${m.index}`);
    last = m.index + m[0].length;
    const tag = m[1] as 'path' | 'circle' | 'rect';
    const attrs: Record<string, string> = {};
    const attrRe = /([a-z-]+)="([^"]*)"/g;
    for (let a = attrRe.exec(m[2] ?? ''); a; a = attrRe.exec(m[2] ?? '')) {
      const name = a[1] as string;
      if (!(ALLOWED[tag] as string[]).includes(name))
        throw new Error(`<${tag}> may not have "${name}"`);
      if (name in attrs) throw new Error(`<${tag}> repeats "${name}"`);
      attrs[name] = a[2] as string;
    }
    const num = (name: string, required = true) => {
      const raw = attrs[name];
      if (raw === undefined) {
        if (required) throw new Error(`<${tag}> needs ${name}`);
        return 0;
      }
      if (!/^-?\d+(\.\d+)?$/.test(raw))
        throw new Error(`<${tag}> ${name}="${raw}" is not a number`);
      return Number(raw);
    };
    if (tag === 'path') {
      if (attrs.d === undefined) throw new Error('<path> needs d');
      shapes.push({ tag, d: attrs.d });
    } else if (tag === 'circle') shapes.push({ tag, cx: num('cx'), cy: num('cy'), r: num('r') });
    else
      shapes.push({
        tag,
        x: num('x'),
        y: num('y'),
        width: num('width'),
        height: num('height'),
        rx: num('rx', false),
      });
  }
  if (body.slice(last).trim() !== '') throw new Error('unexpected markup after the last shape');
  if (shapes.length === 0) throw new Error('no shapes');
  return shapes;
}

export type IconReport = { box: Box; problems: string[] };

const TOLERANCE = 0.25;

/**
 * Checks one icon. Stroke icons must keep their geometry inside 1..23 (the 2px stroke then stays
 * inside the 24px box); fill icons inside 0..24 and every subpath of a path must be closed.
 */
export function checkIcon(style: 'stroke' | 'fill', body: string): IconReport {
  const problems: string[] = [];
  const box = empty();
  let shapes: Shape[] = [];
  try {
    shapes = parseBody(body);
  } catch (error) {
    return { box, problems: [(error as Error).message] };
  }
  for (const s of shapes) {
    try {
      if (s.tag === 'path') {
        const info = pathInfo(s.d);
        add(box, info.box.minX, info.box.minY);
        add(box, info.box.maxX, info.box.maxY);
        if (style === 'fill' && info.closedSubpaths !== info.subpaths)
          problems.push('a filled path has an open subpath (end it with Z)');
      } else if (s.tag === 'circle') {
        if (s.r <= 0) problems.push('circle radius must be positive');
        add(box, s.cx - s.r, s.cy - s.r);
        add(box, s.cx + s.r, s.cy + s.r);
      } else {
        if (s.width <= 0 || s.height <= 0) problems.push('rect needs a positive size');
        add(box, s.x, s.y);
        add(box, s.x + s.width, s.y + s.height);
      }
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const lo = style === 'stroke' ? 1 : 0;
  const hi = 24 - lo;
  if (
    box.minX < lo - TOLERANCE ||
    box.minY < lo - TOLERANCE ||
    box.maxX > hi + TOLERANCE ||
    box.maxY > hi + TOLERANCE
  ) {
    problems.push(
      `bounds ${box.minX.toFixed(2)},${box.minY.toFixed(2)} to ${box.maxX.toFixed(2)},${box.maxY.toFixed(2)} leave ${lo}..${hi}`,
    );
  }
  return { box, problems };
}
