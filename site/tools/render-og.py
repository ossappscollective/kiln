#!/usr/bin/env python3
"""Render site/static/assets/og.png (1200x630) with Pillow and numpy, mirroring og.svg.

Why: ImageMagick's built-in SVG renderer ignores gradients and no other SVG renderer is assumed to exist. Run it again
after changing og.svg or the tagline below. Usage: python3 site/tools/render-og.py
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, SS = 1200, 630, 2
OUT = os.path.join(os.path.dirname(__file__), '..', 'static', 'assets', 'og.png')


def hexrgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=float)


def vgrad(w, h, y0, y1, stops):
    ys = np.clip((np.arange(h) - y0) / max(y1 - y0, 1e-6), 0, 1)
    out = np.zeros((h, w, 3))
    for c in range(3):
        out[:, :, c] = np.interp(ys, [s[0] for s in stops], [hexrgb(s[1])[c] for s in stops])[:, None]
    return out


def hgrad(w, h, x0, x1, stops):
    xs = np.clip((np.arange(w) - x0) / max(x1 - x0, 1e-6), 0, 1)
    out = np.zeros((h, w, 3))
    for c in range(3):
        out[:, :, c] = np.interp(xs, [s[0] for s in stops], [hexrgb(s[1])[c] for s in stops])[None, :]
    return out


def bez(p0, p1, p2, p3, n=24):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return pts


def font(size, bold=True):
    for path in ('/usr/share/fonts/truetype/liberation2/LiberationSans-%s.ttf' % ('Bold' if bold else 'Regular'),
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf' % ('-Bold' if bold else '')):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


w, h = W * SS, H * SS
# background: diagonal gradient plus two soft glows
yy, xx = np.mgrid[0:h, 0:w]
t = (xx / w + yy / h) / 2
bg = hexrgb('#171b3d')[None, None, :] * (1 - t[..., None]) + hexrgb('#0b0d22')[None, None, :] * t[..., None]


def glow(img, cx, cy, r, color, alpha):
    d = np.sqrt((xx - cx * w) ** 2 + (yy - cy * h) ** 2) / (r * w)
    a = np.clip(1 - d, 0, 1)[..., None] * alpha
    return img * (1 - a) + hexrgb(color)[None, None, :] * a


bg = glow(bg, 0.85, 0.0, 0.6, '#7f99ff', 0.35)
bg = glow(bg, 0.95, 1.0, 0.45, '#ffb04a', 0.18)


def to_px(x, y):  # mark coordinates -> pixels (translate(60 90) scale(3.8), then supersample)
    return ((60 + x * 3.8) * SS, (90 + y * 3.8) * SS)


# arch stroke
mask = Image.new('L', (w, h), 0)
d = ImageDraw.Draw(mask)
sw = 8 * 3.8 * SS
pts = [to_px(28, 98), to_px(28, 58)]
pts += [to_px(60 - 32 * math.cos(math.radians(a)), 58 - 32 * math.sin(math.radians(a))) for a in range(0, 181, 3)]
pts += [to_px(92, 58), to_px(92, 98)]
for a, b in zip(pts, pts[1:]):  # round brush along the path: no joint artefacts
    n = max(int(math.hypot(b[0] - a[0], b[1] - a[1]) / 2), 1)
    for k in range(n + 1):
        x, y = a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n
        d.ellipse([x - sw / 2, y - sw / 2, x + sw / 2, y + sw / 2], fill=255)
arch = vgrad(w, h, to_px(0, 22)[1], to_px(0, 100)[1], [(0, '#7f99ff'), (0.6, '#a98bff'), (1, '#ffb04a')])
m = np.asarray(mask, dtype=float)[..., None] / 255
bg = bg * (1 - m) + arch * m

# flame
segs = [((60, 42), (62, 53), (74, 59), (74, 74)), ((74, 74), (74, 85), (68, 94), (60, 94)),
        ((60, 94), (52, 94), (46, 85), (46, 74)), ((46, 74), (46, 66), (50, 61), (54, 56)),
        ((54, 56), (55, 62), (57, 65), (60, 66)), ((60, 66), (59, 58), (58, 50), (60, 42))]
poly = []
for s in segs:
    poly += [to_px(*p) for p in bez(*s)]
mask = Image.new('L', (w, h), 0)
ImageDraw.Draw(mask).polygon(poly, fill=255)
fire = vgrad(w, h, to_px(0, 40)[1], to_px(0, 96)[1], [(0, '#c9a8ff'), (0.55, '#ff9f6e'), (1, '#ffb04a')])
m = np.asarray(mask, dtype=float)[..., None] / 255
bg = bg * (1 - m) + fire * m

img = Image.fromarray(np.clip(bg, 0, 255).astype('uint8'), 'RGB')
d = ImageDraw.Draw(img)
X = 520 * SS

# wordmark with a horizontal gradient
word = Image.new('L', (w, h), 0)
ImageDraw.Draw(word).text((X, 130 * SS), 'Kiln', font=font(132 * SS), fill=255)
g = hgrad(w, h, X, X + 300 * SS, [(0, '#eceeff'), (1, '#a98bff')])
img = Image.composite(Image.fromarray(g.astype('uint8'), 'RGB'), img, word)
d = ImageDraw.Draw(img)
d.text((X, 300 * SS), 'Ship iOS, macOS and Android', font=font(36 * SS), fill='#eceeff')
d.text((X, 350 * SS), 'releases from one open-source place.', font=font(36 * SS), fill='#eceeff')
d.text((X, 428 * SS), 'Store listings, ASO and insights. Self-hosted.', font=font(28 * SS, False), fill='#a3a9d6')
for i, label in enumerate(('Apache-2.0', 'Self-hosted', 'No telemetry')):
    x = X + i * 186 * SS
    d.rounded_rectangle([x, 498 * SS, x + 170 * SS, 542 * SS], radius=22 * SS, fill='#232a54')
    f = font(24 * SS)
    tw = d.textlength(label, font=f)
    d.text((x + (170 * SS - tw) / 2, 505 * SS), label, font=f, fill='#b9c6ff')

img = img.resize((W, H), Image.LANCZOS)
img.save(OUT, optimize=True)
print('wrote', os.path.normpath(OUT), os.path.getsize(OUT), 'bytes')
