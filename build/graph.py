"""Turn simplified TopoJSON into areas and neighbour lists.

usage: python graph.py <topo.json> <out.npz>

Neighbours are polygons that share a border, plus polygons facing each other
across a narrow gap (a river or strait clipped out of the shoreline file).
"""
import json, sys
import numpy as np
import shapely
from shapely import STRtree

GAP_KM = 2.0


def load(path):
    t = json.load(open(path))
    sx, sy = t["transform"]["scale"]; tx, ty = t["transform"]["translate"]
    arcs = []
    for a in t["arcs"]:
        a = np.cumsum(np.array(a, dtype=np.int64), axis=0)
        arcs.append(np.c_[a[:, 0] * sx + tx, a[:, 1] * sy + ty])
    obj = next(iter(t["objects"].values()))["geometries"]
    ids, polys = [], []
    for g in obj:
        ids.append(g["properties"]["g"])
        polys.append([g["arcs"]] if g["type"] == "Polygon" else (g["arcs"] if g["type"] == "MultiPolygon" else []))
    order = np.argsort(ids)
    return arcs, [ids[i] for i in order], [polys[i] for i in order]


def ring_xy(arcs, ring):
    out = []
    for a in ring:
        p = arcs[a] if a >= 0 else arcs[~a][::-1]
        out.append(p[:-1])
    return np.concatenate(out)


def shoelace(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


def main(path, out):
    arcs, ids, polys = load(path)
    n = len(ids)
    print(n, "units,", len(arcs), "arcs,", sum(map(len, arcs)), "arc vertices", "empty:", [i for i, p in zip(ids, polys) if not p])
    area = np.zeros(n)
    owner = [[] for _ in arcs]
    geoms, total = [], 0
    for i, mp in enumerate(polys):
        parts = []
        for poly in mp:
            rings = [ring_xy(arcs, r) for r in poly]
            total += sum(map(len, rings))
            area[i] += abs(shoelace(rings[0])) - sum(abs(shoelace(r)) for r in rings[1:])
            parts.append(shapely.Polygon(rings[0], rings[1:]))
            for r in poly:
                for a in r:
                    owner[a if a >= 0 else ~a].append(i)
        geoms.append(shapely.MultiPolygon(parts))
    print(total, "polygon vertices; min area", area.min(), "zero", (area <= 1e-9).sum())
    touch = {}
    for a, o in enumerate(owner):
        s = sorted(set(o))
        if len(s) == 2:
            d = np.diff(arcs[a], axis=0)
            touch[tuple(s)] = touch.get(tuple(s), 0) + float(np.hypot(d[:, 0], d[:, 1]).sum())
    geoms = np.array(geoms, dtype=object)
    bounds = np.array([geoms[i] for i in range(n)])
    b = shapely.bounds(geoms)
    # gaps: only polygons with an outer (unshared) edge can face water
    coastal = np.zeros(n, bool)
    for o in owner:
        if len(set(o)) == 1:
            coastal[o[0]] = True
    ci = np.where(coastal)[0]
    tree = STRtree(geoms[ci])
    q, r = tree.query(geoms[ci], predicate="dwithin", distance=GAP_KM)
    gap = {}
    for i, j in zip(ci[q], ci[r]):
        if i < j and (i, j) not in touch:
            gap[(int(i), int(j))] = float(shapely.distance(geoms[i], geoms[j]))
    print(len(touch), "touching pairs,", len(gap), "gap pairs")
    e = np.array(list(touch) + list(gap), dtype=np.int32)
    w = np.array(list(touch.values()) + [0.0] * len(gap))
    g = np.array([0.0] * len(touch) + list(gap.values()))
    c = shapely.centroid(geoms)
    np.savez(out, ids=np.array(ids), area=area, edge=e, length=w, gap=g, isgap=np.r_[np.zeros(len(touch), bool), np.ones(len(gap), bool)],
             bounds=b, cx=shapely.get_x(c), cy=shapely.get_y(c))


if __name__ == "__main__":
    main(*sys.argv[1:3])
