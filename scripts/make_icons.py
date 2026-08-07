#!/usr/bin/env python3
"""Generate the extension icons (blue shield with a white check and a red stripe)."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'static', 'icons')
os.makedirs(OUT, exist_ok=True)

BLUE = (10, 102, 194, 255)
RED = (201, 69, 48, 255)
WHITE = (255, 255, 255, 255)


def px(v, scale):
    return int(v * scale)


def draw_icon(size):
    w = h = size
    scale = w / 128
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Shield body
    d.rounded_rectangle(
        [px(12, scale), px(8, scale), px(116, scale), px(118, scale)],
        radius=px(24, scale), fill=BLUE
    )
    # Check mark
    d.line(
        [(px(36, scale), px(62, scale)), (px(56, scale), px(82, scale)), (px(94, scale), px(44, scale))],
        fill=WHITE, width=max(1, px(10, scale)), joint='curve'
    )
    # Red accent stripe at the bottom
    d.rounded_rectangle(
        [px(12, scale), px(98, scale), px(116, scale), px(118, scale)],
        radius=px(8, scale), fill=RED
    )
    img.save(os.path.join(OUT, f'icon{w}.png'))
    print(f'wrote icon{w}.png')


if __name__ == '__main__':
    for s in (16, 32, 48, 128):
        draw_icon(s)
    print('Icons generated in', os.path.abspath(OUT))
