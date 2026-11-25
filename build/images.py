"""Write the pictures the site uses: one big render, scaled down to each size.

usage: python images.py <topo.json> <colors.npz> <out-dir>
"""
import sys
import numpy as np
from PIL import Image
from raster import BG, colorize, id_buffer, shrink

topo, colors, out = sys.argv[1:4]
rgb = np.load(colors)["rgb"]
Image.MAX_IMAGE_PIXELS = None
ids, _ = id_buffer(topo, 19200)
rows = ids.shape[0] // 192 * 192
big = np.concatenate([shrink(colorize(ids[y:y + 192], rgb), 2) for y in range(0, rows, 192)])
del ids
print(big.shape)
# the viewer draws this one while towns are too small to resolve
Image.fromarray(shrink(big, 4)).save(f"{out}/overview.webp", lossless=True, method=6)
for f, name in ((8, "w1200"), (20, "w480"), (60, "w160")):
    Image.fromarray(shrink(big, f)).save(f"{out}/{name}.png", optimize=True)
# social card: 1200x630 with the map centred
m = Image.fromarray(shrink(big, 8))
m = m.resize((int(m.width * 620 / m.height), 620), Image.LANCZOS)
card = Image.new("RGB", (1200, 630), BG)
card.paste(m, ((1200 - m.width) // 2, 5))
card.save(f"{out}/card.png", optimize=True)
