"""Render the whole map as one very large PNG, a strip at a time.

usage: python export.py <topo.json> <colors.npz> <out.png> [width]

The size is the largest that ordinary software still opens. Each output pixel is four
samples averaged in linear light. Rows are written as they are finished, so memory
stays small whatever the size.
"""
import struct, sys, time, zlib
import numpy as np
from PIL import Image, ImageDraw
from graph import load, ring_xy, shoelace
from raster import BG

BOX = (-2396.0, -1586.0, 2272.0, 1781.0)   # the land plus 20 km; tighter than the site's picture
WIDTH = 27264   # 536 megapixels. Browsers and Windows refuse any image past 2^29 pixels
SS = 2          # samples per pixel, each way
ROWS = 240      # output rows per strip


def chunk(f, kind, data):
    f.write(struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data)))


def main(topo, colors, out, width):
    rgb = np.vstack([np.array(BG, np.uint8)[None], np.load(colors)["rgb"]])
    k = width * SS / (BOX[2] - BOX[0])
    height = round((BOX[3] - BOX[1]) * width / (BOX[2] - BOX[0]))
    s = np.arange(256) / 255
    dec = np.round(np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4) * 65535).astype(np.uint32)
    l = np.arange(65536) / 65535
    enc = np.round(255 * np.where(l <= 0.0031308, 12.92 * l, 1.055 * l ** (1 / 2.4) - 0.055)).astype(np.uint8)
    lin = dec[rgb]

    # Polygons with holes go first, biggest first, with their holes wiped clean;
    # whatever belongs in a hole is drawn over it afterwards.
    arcs, ids, polys = load(topo)
    holed, plain = [], []
    for i, mp in enumerate(polys):
        for poly in mp:
            rings = [(ring_xy(arcs, r) - BOX[:2]) * k for r in poly]
            (holed if len(rings) > 1 else plain).append((abs(shoelace(rings[0])), i + 1, rings))
    holed.sort(key=lambda p: -p[0])
    jobs = []
    for _, i, rings in holed:
        jobs += [(i, rings[0])] + [(0, r) for r in rings[1:]]
    jobs += [(i, rings[0]) for _, i, rings in plain]
    top = np.array([p[:, 1].min() for _, p in jobs])
    bottom = np.array([p[:, 1].max() for _, p in jobs])

    t0 = time.time()
    z = zlib.compressobj(9, zlib.DEFLATED, 15, 9)
    before = np.zeros((1, width, 3), np.uint8)
    with open(out, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        chunk(f, b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        chunk(f, b"sRGB", b"\0")
        for y0 in range(0, height, ROWS):
            n = min(ROWS, height - y0)
            im = Image.new("I", (width * SS, n * SS), 0)
            d = ImageDraw.Draw(im)
            shift = np.array([0, y0 * SS])
            for j in np.where((top < (y0 + n) * SS + 1) & (bottom > y0 * SS - 1))[0]:
                i, p = jobs[j]
                d.polygon([tuple(q) for q in (p - shift).tolist()], fill=i)
            idb = np.array(im)
            total = sum(lin[idb[a::SS, b::SS]] for a in range(SS) for b in range(SS))
            img = enc[(total + SS * SS // 2) // (SS * SS)]
            up = img - np.concatenate([before, img[:-1]])          # PNG filter 2
            before = img[-1:].copy()
            raw = np.empty((n, 1 + width * 3), np.uint8)
            raw[:, 0] = 2
            raw[:, 1:] = up.reshape(n, -1)
            data = z.compress(raw.tobytes())
            if data:
                chunk(f, b"IDAT", data)
        chunk(f, b"IDAT", z.flush())
        chunk(f, b"IEND", b"")
        size = f.tell()
    print(f"{width} x {height} = {width * height / 1e6:.0f} MP, {width / (BOX[2] - BOX[0]):.2f} px/km, {size / 1e6:.1f} MB, {time.time() - t0:.0f} s")


main(*sys.argv[1:4], int(sys.argv[4]) if len(sys.argv) > 4 else WIDTH)
