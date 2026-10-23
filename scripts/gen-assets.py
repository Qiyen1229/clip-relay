#!/usr/bin/env python3
"""重新產生 PWA 圖示與 iOS 啟動畫面（需要 Pillow：pip install pillow）。
用法：python3 scripts/gen-assets.py
輸出到 public/（icon-*.png、apple-touch-icon.png、splash-*.png）。"""
import os
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)
OUT = os.path.join(os.path.dirname(__file__), '..', 'public')
SS = 4  # 超取樣倍率，邊緣更平滑

# (css 寬, css 高, 像素比)：iPhone / iPad 直向
SPLASH = [
    (320, 568, 2), (375, 667, 2), (414, 736, 3), (375, 812, 3), (414, 896, 2), (414, 896, 3),
    (390, 844, 3), (428, 926, 3), (393, 852, 3), (430, 932, 3), (402, 874, 3), (440, 956, 3),
    (768, 1024, 2), (834, 1112, 2), (820, 1180, 2), (834, 1194, 2), (1024, 1366, 2),
]


def glyph(d, cx, cy, g):
    """在 (cx,cy) 以邊長 g 的範圍畫剪貼簿圖形（白色板、淺色夾子、藍色文字列）。"""
    def rr(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill)
    rr(cx - .36 * g, cy - .42 * g, cx + .36 * g, cy + .46 * g, .10 * g, (255, 255, 255))
    rr(cx - .19 * g, cy - .50 * g, cx + .19 * g, cy - .30 * g, .06 * g, (191, 219, 254))
    rr(cx - .19 * g, cy - .50 * g, cx + .19 * g, cy - .30 * g, .06 * g, (191, 219, 254))
    for i, w in enumerate((.46, .46, .30)):
        y = cy - .14 * g + i * .16 * g
        rr(cx - .23 * g, y, cx - .23 * g + w * g, y + .07 * g, .035 * g, BLUE)


def render(size, scale, bg=BLUE):
    big = size * SS
    img = Image.new('RGB', (big, big), bg)
    glyph(ImageDraw.Draw(img), big / 2, big / 2, big * scale)
    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    img.save(os.path.join(OUT, name), optimize=True)
    print('wrote', name, img.size)


save(render(192, .62), 'icon-192.png')
save(render(512, .62), 'icon-512.png')
save(render(512, .50), 'icon-maskable-512.png')   # 內容縮在安全區（中央 80%）內
save(render(180, .62), 'apple-touch-icon.png')

for w, h, r in SPLASH:
    pw, ph = w * r, h * r
    big = Image.new('RGB', (pw * 2, ph * 2), BLUE)
    glyph(ImageDraw.Draw(big), pw, ph - ph * .02, min(pw, ph) * 2 * .30)
    save(big.resize((pw, ph), Image.LANCZOS), f'splash-{pw}x{ph}.png')

print('\n<!-- 啟動畫面 link 標籤 -->')
for w, h, r in SPLASH:
    print(f'<link rel="apple-touch-startup-image" href="/splash-{w*r}x{h*r}.png" '
          f'media="(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">')
