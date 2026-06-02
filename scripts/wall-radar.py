#!/usr/bin/env python3
"""
Server-side radar generator for the Tally wall.

Composites the dark-map outlines + RainViewer precipitation into a transparent,
ANIMATED WebP (the full ~2h frame sequence) plus a static PNG fallback, centered
on the configured location. The wall lays this over its live gradient with plain
compositing (no mix-blend-mode, no Leaflet), so the display device (a 1GB Pi 3B)
just plays a finished image and never has to composite a live map.

Outputs:
  public/generated/wall-radar.webp  (animated, preferred)
  public/generated/wall-radar.png   (static last frame, fallback)

Run on a schedule every few minutes to keep the rain current.
"""

import io
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw

# --- config -----------------------------------------------------------------
LAT = float(os.environ.get("WALL_LAT", "30.5083"))    # Hutto, TX
LON = float(os.environ.get("WALL_LON", "-97.5469"))
ZOOM = int(os.environ.get("WALL_RADAR_ZOOM", "7"))    # RainViewer max native zoom
W, H = 1280, 720                                        # 16:9, Pi-friendly size
RV_COLOR = 4                                            # RainViewer palette (matches the live wall)
FRAME_MS = 500                                          # per-frame duration in the animation
CARTO = "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png"
OUTDIR = os.path.join(os.path.dirname(__file__), "..", "public", "generated")
TILE = 256
UA = {"User-Agent": "tally-wall-radar/1.0"}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGBA")


def latlon_to_worldpx(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n * TILE
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n * TILE
    return x, y


def stitch(urls_grid, tiles_x, tiles_y, box):
    """urls_grid[(ix,iy)] -> url. Fetch concurrently, paste, crop to box."""
    canvas = Image.new("RGBA", (tiles_x * TILE, tiles_y * TILE), (0, 0, 0, 0))

    def grab(item):
        (ix, iy), url = item
        try:
            return ix, iy, fetch(url)
        except Exception:
            return ix, iy, None

    with ThreadPoolExecutor(max_workers=16) as ex:
        for ix, iy, img in ex.map(grab, urls_grid.items()):
            if img is not None:
                canvas.paste(img, (ix * TILE, iy * TILE))
    return canvas.crop(box)


def main():
    rv = json.load(urllib.request.urlopen(
        urllib.request.Request("https://api.rainviewer.com/public/weather-maps.json", headers=UA), timeout=20))
    frames_meta = rv.get("radar", {}).get("past", [])
    host = rv["host"]

    # tile grid covering a W x H window centered on the location
    cx, cy = latlon_to_worldpx(LAT, LON, ZOOM)
    left, top = cx - W / 2.0, cy - H / 2.0
    x0, y0 = int(left // TILE), int(top // TILE)
    tiles_x = int((left + W) // TILE) - x0 + 1
    tiles_y = int((top + H) // TILE) - y0 + 1
    box = (int(left - x0 * TILE), int(top - y0 * TILE),
           int(left - x0 * TILE) + W, int(top - y0 * TILE) + H)
    coords = [(ix, iy) for ix in range(tiles_x) for iy in range(tiles_y)]

    # --- base map -> faint WHITE outlines on transparent (mimics screen blend) ---
    base = stitch({(ix, iy): CARTO.format(z=ZOOM, x=x0 + ix, y=y0 + iy) for ix, iy in coords},
                  tiles_x, tiles_y, box)
    b = np.asarray(base).astype(np.float32) / 255.0
    lum = 0.2126 * b[..., 0] + 0.7152 * b[..., 1] + 0.0722 * b[..., 2]
    outline_a = np.clip((lum - 0.10) * 2.4, 0.0, 0.42)

    # --- vignette mask (computed once) ---
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt(((xx - W / 2) / (W * 0.62)) ** 2 + ((yy - H * 0.42) / (H * 0.60)) ** 2)
    vig = np.clip(1.0 - np.clip((d - 0.56) / 0.44, 0, 1), 0, 1)

    cxp, cyp = W // 2, int(H * 0.42)

    def compose(rain_layer):
        r = np.asarray(rain_layer).astype(np.float32) / 255.0
        ra = r[..., 3]
        out = np.zeros((H, W, 4), np.float32)
        out[..., 0:3] = 1.0                                  # white outlines...
        out[..., 0:3] = out[..., 0:3] * (1 - ra[..., None]) + r[..., 0:3] * ra[..., None]  # ...with rain on top
        a = outline_a * (1 - ra) + ra * 0.92                 # combine alphas
        out[..., 3] = a * vig                                # apply vignette
        img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA")
        draw = ImageDraw.Draw(img)
        draw.ellipse([cxp - 18, cyp - 18, cxp + 18, cyp + 18], fill=(47, 128, 255, 70))
        draw.ellipse([cxp - 8, cyp - 8, cxp + 8, cyp + 8], fill=(47, 128, 255, 255),
                     outline=(255, 255, 255, 255), width=3)
        return img

    frames = []
    for fm in frames_meta:
        rain = stitch({(ix, iy): f"{host}{fm['path']}/{TILE}/{ZOOM}/{x0 + ix}/{y0 + iy}/{RV_COLOR}/1_1.png"
                       for ix, iy in coords}, tiles_x, tiles_y, box)
        frames.append(compose(rain))

    os.makedirs(OUTDIR, exist_ok=True)

    # animated webp (preferred) + static png fallback (last/most-recent frame)
    webp = os.path.join(OUTDIR, "wall-radar.webp")
    tmp = webp + ".tmp"
    frames[0].save(tmp, "WEBP", save_all=True, append_images=frames[1:],
                   duration=FRAME_MS, loop=0, quality=72, method=4)
    os.replace(tmp, webp)

    png = os.path.join(OUTDIR, "wall-radar.png")
    tmpp = png + ".tmp"
    frames[-1].save(tmpp, "PNG")
    os.replace(tmpp, png)

    print(f"wrote {webp} ({os.path.getsize(webp)} bytes, {len(frames)} frames) "
          f"+ {png} ({os.path.getsize(png)} bytes)")


if __name__ == "__main__":
    main()
