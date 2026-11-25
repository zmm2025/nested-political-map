"""Pack geometry, colours and names into the one file the page loads.

usage: python pack.py <topo.json> <names.json> <graph.npz> <colors.npz> <place_by_county.txt> <out.bin>
"""
import collections, gzip, json, struct, sys
import numpy as np
from graph import load
from oklab import *

Q = 128  # grid steps per km


def varint(a):
    """LEB128 for a 1-D array of non-negative ints."""
    a = np.asarray(a, dtype=np.uint64)
    out = np.zeros((len(a), 10), np.uint8)
    nb = np.ones(len(a), int)
    v = a.copy()
    for k in range(10):
        out[:, k] = v & 127
        v >>= np.uint64(7)
        more = v > 0
        nb[more] = k + 2
        if not more.any():
            break
    idx = np.arange(10)[None] < nb[:, None]
    out[np.arange(10)[None] < (nb - 1)[:, None]] |= 128
    return out[idx].tobytes()


def zig(a):
    a = np.asarray(a, dtype=np.int64)
    return ((a << 1) ^ (a >> 63)).astype(np.uint64)


def pct(x):
    return [round(float(v), 4) for v in np.percentile(x, [0, 5, 50])]


def main(topo, names, graph, colors, places, out):
    arcs, ids, polys = load(topo)
    nm = json.load(open(names, encoding="utf-8"))
    g, c = np.load(graph), np.load(colors)
    lens, dx, dy, pos = [], [], [], np.zeros(2, np.int64)
    for a in arcs:
        p = np.round(a * Q).astype(np.int64)
        keep = np.r_[True, np.any(np.diff(p, axis=0) != 0, axis=1)]
        if keep.sum() < 4 and len(p) >= 4 and (a[0] == a[-1]).all():
            keep[:] = True
        p = p[keep]
        d = np.diff(np.vstack([pos, p]), axis=0)
        pos = p[-1]
        lens.append(len(p)); dx.append(d[:, 0]); dy.append(d[:, 1])
    xy = np.empty(sum(lens) * 2, np.int64)
    xy[0::2], xy[1::2] = np.concatenate(dx), np.concatenate(dy)
    struct_, refs, last = [], [], 0
    for mp in polys:
        struct_.append(len(mp))
        for poly in mp:
            struct_.append(len(poly))
            for ring in poly:
                struct_.append(len(ring))
                for a in ring:
                    refs.append(a - last); last = a

    X, e = from8(c["rgb"]), g["edge"]
    t = ~g["isgap"]
    de = np.linalg.norm(X[e[:, 0]] - X[e[:, 1]], axis=1)
    ce, sp = c["ce"], c["spairs"]
    dc = np.linalg.norm(c["cm"][ce[:, 0]] - c["cm"][ce[:, 1]], axis=1)
    sm = c["sm"]
    ds = np.linalg.norm(sm[sp[:, 0]] - sm[sp[:, 1]], axis=1)
    vis = [np.linalg.norm(cvd(sm, m)[sp[:, 0]] - cvd(sm, m)[sp[:, 1]], axis=1) for m in (DEUTAN, PROTAN)]
    d = collections.defaultdict(set)
    for l in open(places, encoding="utf-8").read().splitlines()[1:]:
        p = l.split("|")
        if p[7] == "INCORPORATED PLACE" and p[9] == "A":
            d[p[1] + p[4]].add(p[3])
    meta = {
        "states": [[*nm["states"][s], int(f)] for s, f in zip(c["states"], c["fam"])],
        "families": c["family_names"].tolist(),
        "counties": [nm["counties"][k] for k in c["counties"]],
        "countyState": c["s_of_c"].tolist(),
        "subs": [nm["subs"][i] for i in ids],
        "metrics": {
            "state": pct(ds), "county": pct(dc[~c["cross"]]), "sub": pct(de[t & ~c["sc"]]),
            "subAll": pct(de[t]), "statePairs": len(sp), "countyPairs": int((~c["cross"]).sum()), "subPairs": int((t & ~c["sc"]).sum()),
            "countyErr": round(float(np.linalg.norm(c["cm"] - c["C"], axis=1).max()), 4),
            "stateErr": round(float(np.linalg.norm(sm - c["S"], axis=1).max()), 4),
            "cvdMin": round(float(min(v.min() for v in vis)), 4),
            "places": len(d), "placesSplit": sum(len(v) > 1 for v in d.values()),
        },
    }
    print(json.dumps(meta["metrics"], indent=1))
    secs = [json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode(),
            varint(lens), varint(zig(xy)), varint(struct_), varint(zig(refs)),
            c["rgb"].tobytes(), c["county_rgb"].tobytes(), c["state_rgb"].tobytes(),
            varint(zig(np.diff(np.r_[0, c["c_of"]])))]
    body = struct.pack("<4I", Q, len(ids), len(arcs), len(secs)) + struct.pack(f"<{len(secs)}I", *map(len, secs)) + b"".join(secs)
    z = gzip.compress(body, 9, mtime=0)
    open(out, "wb").write(z)
    print("sections", [len(s) for s in secs], "gz", len(z))


main(*sys.argv[1:7])
