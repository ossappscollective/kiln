#!/usr/bin/env python3
"""Draws the Kiln mark (two nested arches, glowing, on a dark tile) and writes every icon Tauri needs.

Run from this folder with Pillow installed:  python3 make-icons.py
The same geometry is in apps/web/public/favicon.svg and apps/web/src/components/ui/Logo.svelte (120-unit tile, arches 8 units thick).
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

SIZE = 1024
SS = 2  # supersampling
S = SIZE * SS
U = S / 120  # one tile unit in pixels

TOP, BOTTOM = (23, 27, 61), (11, 13, 34)
STOPS = [(0.0, (127, 153, 255)), (0.55, (169, 139, 255)), (1.0, (255, 176, 74))]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def stop(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def vertical_gradient(top, bottom):
    column = Image.new('RGB', (1, S))
    column.putdata([lerp(top, bottom, y / (S - 1)) for y in range(S)])
    return column.resize((S, S))


def stroke_mask():
    mask = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(mask)
    w = round(8 * U)
    h = w / 2

    def arch_path(x0, x1, y_spring, y_bottom):
        r = (x1 - x0) / 2
        cx = (x0 + x1) / 2
        d.line([(x0 * U, y_bottom * U), (x0 * U, y_spring * U)], fill=255, width=w)
        d.line([(x1 * U, y_bottom * U), (x1 * U, y_spring * U)], fill=255, width=w)
        d.arc([(cx - r) * U, (y_spring - r) * U, (cx + r) * U, (y_spring + r) * U], 180, 360, fill=255, width=w)
        for x, y in ((x0, y_bottom), (x1, y_bottom), (x0, y_spring), (x1, y_spring)):
            d.ellipse([x * U - h, y * U - h, x * U + h, y * U + h], fill=255)

    # Tile coordinates: the outer arch 32..88 wide, springing at y 56, down to 94; the inner one 48..72, springing at 64.
    arch_path(32, 88, 56, 94)
    arch_path(48, 72, 64, 94)
    return mask


def build():
    tile = vertical_gradient(TOP, BOTTOM).convert('RGBA')
    corner = Image.new('L', (S, S), 0)
    ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=round(30 * U), fill=255)

    mask = stroke_mask()
    # The strokes take their colour from a gradient running from y=20 to y=100 of the tile.
    gradient = Image.new('RGB', (1, S))
    gradient.putdata([stop(min(max((y / U - 20) / 80, 0), 1)) for y in range(S)])
    gradient = gradient.resize((S, S))
    glow_mask = mask.filter(ImageFilter.GaussianBlur(5 * U)).point(lambda v: round(v * 0.7))

    out = tile.copy()
    out.paste(gradient, (0, 0), glow_mask)
    out.paste(gradient, (0, 0), mask)
    out.putalpha(ImageChops.multiply(corner, Image.new('L', (S, S), 255)))
    return out.resize((SIZE, SIZE), Image.LANCZOS)


icon = build()
icon.save('source-1024.png')
icon.resize((512, 512), Image.LANCZOS).save('icon.png')
icon.resize((256, 256), Image.LANCZOS).save('128x128@2x.png')
icon.resize((128, 128), Image.LANCZOS).save('128x128.png')
icon.resize((32, 32), Image.LANCZOS).save('32x32.png')
icon.save('icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.save('icon.icns')
print('written')
