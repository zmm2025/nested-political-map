"""Rasterise the map with no outlines: ids first, then linear-light downsampling."""
import numpy as np
from PIL import Image, ImageDraw
from graph import load, ring_xy

BOX = (-2460.0, -1650.0, 2340.0, 1806.0)   # layout window, km
BG = (236, 237, 239)


def id_buffer(topo, width):
    arcs, ids, polys = load(topo)
    k = width / (BOX[2] - BOX[0])
    h = round((BOX[3] - BOX[1]) * k)
    im = Image.new("I", (width, h), 0)
    dr = ImageDraw.Draw(im)
    for i, mp in enumerate(polys):
        for poly in mp:
            rs = [((ring_xy(arcs, r) - BOX[:2]) * k) for r in poly]
            if len(rs) == 1:
                dr.polygon([tuple(p) for p in rs[0]], fill=i + 1)
                continue
            lo = np.floor(rs[0].min(0)).astype(int)
            hi = np.ceil(rs[0].max(0)).astype(int) + 1
            m = Image.new("1", tuple(int(a) for a in hi - lo), 0)
            md = ImageDraw.Draw(m)
            md.polygon([tuple(p - lo) for p in rs[0]], fill=1)
            for q in rs[1:]:
                md.polygon([tuple(p - lo) for p in q], fill=0)
            im.paste(i + 1, tuple(int(a) for a in lo), m)
    return np.array(im), ids


def colorize(idb, rgb, bg=BG):
    return np.vstack([np.array(bg, np.uint8)[None], rgb])[idb]


def shrink(img, f):
    h, w = img.shape[0] // f * f, img.shape[1] // f * f
    img = img[:h, :w].astype(np.float32) / 255
    lin = np.where(img <= 0.04045, img / 12.92, ((img + 0.055) / 1.055) ** 2.4)
    lin = lin.reshape(h // f, f, w // f, f, 3).mean((1, 3))
    return np.round(255 * np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)).astype(np.uint8)
