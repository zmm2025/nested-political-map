"""Choose every colour on the map.

usage: python colors.py <graph.npz> <out.npz>

Three levels, solved from the top down:
  states        a hue family each; neighbours far apart in OKLab
  counties      spread out inside the state's family so neighbours contrast
  subdivisions  spread out in a small ball around the county's colour
Under one hard rule: the area-weighted mean of the children, taken in linear
light, equals the parent. Linear light is how a screen, a lens and an eye mix.
"""
import sys
import numpy as np
from oklab import *

rng = np.random.default_rng(7)

# name, hue, anchor L, anchor C, L range, chroma range
FAMILIES = [
    ("red",     24, 0.580, 0.146, (0.45, 0.72), (0.105, 0.185)),
    ("amber",   81, 0.805, 0.122, (0.69, 0.91), (0.078, 0.165)),
    ("green",  144, 0.675, 0.126, (0.51, 0.83), (0.080, 0.175)),
    ("teal",   212, 0.770, 0.080, (0.62, 0.90), (0.045, 0.120)),
    ("blue",   261, 0.530, 0.130, (0.38, 0.68), (0.080, 0.180)),
    ("violet", 322, 0.665, 0.140, (0.52, 0.81), (0.085, 0.195)),
]
HUE_HALF = 12.0
# state pairs that meet only at a point, or face each other over a lake or bay
EXTRA = [("04", "08"), ("35", "49"), ("26", "17"), ("26", "27"), ("36", "44"), ("24", "34"), ("36", "26"), ("39", "36")]


def agg(edge, lab, w):
    """Collapse child edges to unique parent pairs, summing border length."""
    p = np.sort(lab[edge], axis=1)
    m = p[:, 0] != p[:, 1]
    u, inv = np.unique(p[m], axis=0, return_inverse=True)
    return u, np.bincount(inv.ravel(), w[m])


def assign_states(n, pairs):
    K = len(FAMILIES)
    anchors = np.array([lch(f[2], f[3], f[1]) for f in FAMILIES])

    def dist(x):
        return np.linalg.norm(x[:, None] - x[None], axis=-1)

    d = dist(anchors)
    dv = np.minimum(dist(cvd(anchors, DEUTAN)), dist(cvd(anchors, PROTAN)))
    cost = np.exp(-d / 0.035) + 0.35 * np.exp(-dv / 0.035)
    # neighbours at one remove should preferably not repeat either
    adj = np.zeros((n, n), bool)
    adj[pairs[:, 0], pairs[:, 1]] = adj[pairs[:, 1], pairs[:, 0]] = True
    second = ((adj.astype(int) @ adj.astype(int)) > 0) & ~adj
    np.fill_diagonal(second, False)
    W = adj * 1.0
    same = second * 0.06

    def total(c):
        return (W * cost[c][:, c]).sum() / 2 + (same * (c[:, None] == c[None])).sum() / 2

    best = None
    for _ in range(60):
        c = rng.integers(0, K, n)
        cnt = np.bincount(c, minlength=K).astype(float)
        T = 1.0
        for _ in range(6000):
            i, k = rng.integers(n), rng.integers(K)
            o = c[i]
            if k == o:
                continue
            # the last term keeps the families in rough balance
            de = W[i] @ (cost[k][c] - cost[o][c]) + same[i] @ ((c == k) * 1.0 - (c == o)) + 0.012 * (cnt[k] - cnt[o] + 1)
            if de < 0 or rng.random() < np.exp(-de / T):
                c[i] = k
                cnt[o] -= 1
                cnt[k] += 1
            T = max(T * 0.9988, 1e-3)
        e = total(c) + 0.006 * (np.bincount(c, minlength=K) ** 2).sum()
        if best is None or e < best[0]:
            best = (e, c.copy())
    return best[1], anchors


def gamut_push(x, lo, hi):
    """OKLab step that brings x back to lo <= linear RGB <= hi (first order)."""
    lin = lab2lin(x)
    over = np.maximum(0, lo - lin) - np.maximum(0, lin - hi)
    out = np.zeros_like(x)
    k = np.where(np.any(over, axis=1))[0]
    if len(k):
        J = jac(x[k])
        out[k] = np.einsum("nij,ni->nj", J, over[k] / (J ** 2).sum(2))
    return out


def solve(x0, edge, target, weight, group, w, parent, planes, radius, iters, noise, gamut, repair=150):
    """Push neighbours apart by Adam, re-centring every group each step.

    planes: list of (normal[n,3], offset[n]) half spaces, normal.x >= offset
    radius: max distance from the parent colour, or None
    """
    n, G = len(x0), len(parent)
    x = x0.copy()
    wsum = np.bincount(group, w, G)
    plin = lab2lin(parent)
    Jinv = np.linalg.inv(jac(parent))
    m = np.zeros_like(x)
    v = np.zeros_like(x)
    i, j = edge[:, 0], edge[:, 1]

    def recentre(x, k=1):
        for _ in range(k):
            mean = np.stack([np.bincount(group, w * c, G) for c in lab2lin(x).T], 1) / wsum[:, None]
            x = x - np.einsum("gij,gj->gi", Jinv, mean - plin)[group]
        return x

    for t in range(iters):
        prog = t / iters
        g = np.zeros_like(x)
        d = x[i] - x[j]
        r = np.sqrt((d * d).sum(1) + 1e-8)
        s = np.maximum(0, 1 - r / target)
        # a quadratic hinge, sharpened for the closest pairs
        f = weight * (s + 4 * s ** 3) / target / r
        fd = d * f[:, None]
        for a in range(3):
            g[:, a] -= np.bincount(i, fd[:, a], n) - np.bincount(j, fd[:, a], n)
        g -= 900 * gamut_push(x, *gamut)
        for nrm, off in planes:
            s = np.maximum(0, off - (nrm * x).sum(1))
            g -= 900 * s[:, None] * nrm
        if radius is not None:
            q = x - parent[group]
            l = np.sqrt((q * q).sum(1) + 1e-12)
            g += 900 * (np.maximum(0, l - radius) / l)[:, None] * q
        lr = 0.006 * (1 - prog) ** 0.7 + 0.0002
        m = 0.9 * m + 0.1 * g
        v = 0.98 * v + 0.02 * g * g
        x = x - lr * m / (np.sqrt(v) + 1e-6)
        if prog < 0.6:
            x += rng.normal(0, noise * (1 - prog / 0.6), x.shape)
        x = recentre(x)
    def settle(x):
        """Alternate projecting strays onto the gamut and exact re-centring."""
        for _ in range(60):
            for _ in range(3):
                x = x + gamut_push(x, gamut[0] * 0.6, 1 - (1 - gamut[1]) * 0.6)
            x = recentre(x)
        return recentre(x, 2)

    # Gradient descent can wedge two neighbours on the same spot, squeezed evenly
    # from all sides. Jump one item per group somewhere better, and keep the jump
    # only if the whole group ends up less crowded once it has been re-centred.
    x = settle(x)
    reach = target * np.where(weight < 0.35, 0.4, 1.0)
    nb = [[] for _ in range(n)]
    for a, b, tt in zip(i.tolist(), j.tolist(), reach.tolist()):
        nb[a].append((b, tt))
        nb[b].append((a, tt))
    nbi = [np.array([b for b, _ in l], int) for l in nb]
    nbt = [np.array([t_ for _, t_ in l]) for l in nb]
    size = np.bincount(group, minlength=G)
    spread = radius if radius is not None else 0.14

    def energy(x):
        ratio = np.linalg.norm(x[i] - x[j], axis=1) / reach
        e = np.exp(-9 * np.minimum(ratio, 1.2))
        worst = np.full(n, 9.0)
        np.minimum.at(worst, i, ratio)
        np.minimum.at(worst, j, ratio)
        return worst, np.bincount(group[i], e, G) + np.bincount(group[j], e, G)

    for rnd in range(repair):
        worst, e0 = energy(x)
        todo = np.where((worst < 0.75) & (size[group] > 1))[0]
        if rnd % 30 == 0:
            print("  repair", rnd, "crowded", len(todo), "energy", e0.sum().round(2))
        if not len(todo):
            break
        key = worst[todo] + rng.random(len(todo)) * 0.5
        todo = todo[np.argsort(key)]
        todo = todo[np.unique(group[todo], return_index=True)[1]]
        y = x.copy()
        for u in todo:
            p = parent[group[u]]
            c = np.vstack([x[u], p + rng.normal(0, spread / 1.6, (60, 3))])
            ok = np.linalg.norm(c - p, axis=1) <= spread
            for nrm, off in planes:
                ok &= c @ nrm[u] >= off[u] - 0.004
            ok &= ~np.any(gamut_push(c, *gamut), axis=1)
            ok[0] = True
            d = np.linalg.norm(c[:, None] - x[nbi[u]][None], axis=2) / nbt[u]
            e = np.exp(-9 * np.minimum(d, 1.2)).sum(1)
            e[~ok] = np.inf
            y[u] = c[int(e.argmin())]
        y = settle(y)
        _, e1 = energy(y)
        out = np.bincount(group, np.abs(gamut_push(y, gamut[0] * 0.3, 1 - (1 - gamut[1]) * 0.3)).sum(1), G) > 1e-3
        back = (e1 > e0) | out
        x = np.where(back[group][:, None], x, y)
    return x


def family_planes(fam, slack=0.0, hue_extra=0.0):
    f = [FAMILIES[k] for k in fam]
    h = np.array([a[1] for a in f], float)
    z = np.zeros(len(f))
    o = z + 1
    Lmin = np.array([a[4][0] for a in f]) - slack
    Lmax = np.array([a[4][1] for a in f]) + slack
    Cmin = np.array([a[5][0] for a in f]) - slack * 0.5
    Cmax = np.array([a[5][1] for a in f]) + slack * 0.5
    lo, hi, c = np.radians(h - HUE_HALF - hue_extra), np.radians(h + HUE_HALF + hue_extra), np.radians(h)
    return [
        (np.stack([o, z, z], 1), Lmin),
        (np.stack([-o, z, z], 1), -Lmax),
        (np.stack([z, np.cos(c), np.sin(c)], 1), Cmin),
        (np.stack([z, -np.cos(c), -np.sin(c)], 1), -Cmax),
        (np.stack([z, -np.sin(lo), np.cos(lo)], 1), z),   # above the low hue edge
        (np.stack([z, np.sin(hi), -np.cos(hi)], 1), z),   # below the high hue edge
    ]


def main(path, out):
    D = np.load(path)
    ids, area, edge, length, isgap = (D[k] for k in ("ids", "area", "edge", "length", "isgap"))
    n = len(ids)
    states, s_of = np.unique([i[:2] for i in ids], return_inverse=True)
    counties, c_of = np.unique([i[:5] for i in ids], return_inverse=True)
    s_of_c = np.searchsorted(states, np.array([c[:2] for c in counties]))
    carea = np.bincount(c_of, area)
    sarea = np.bincount(s_of, area)

    # ---- states
    sp, _ = agg(edge, s_of, length)
    ex = np.array([[np.searchsorted(states, a), np.searchsorted(states, b)] for a, b in EXTRA])
    spairs = np.unique(np.sort(np.r_[sp, ex], axis=1), axis=0)
    fam, anchors = assign_states(len(states), spairs)
    S = anchors[fam]
    ds = np.linalg.norm(S[spairs[:, 0]] - S[spairs[:, 1]], axis=1)
    print("state pairs", len(spairs), "min dE", ds.min().round(3), "median", np.median(ds).round(3))
    print("families", {FAMILIES[k][0]: int(c) for k, c in enumerate(np.bincount(fam, minlength=len(FAMILIES)))})

    # ---- counties
    ce, _ = agg(edge, c_of, length)
    cross = s_of_c[ce[:, 0]] != s_of_c[ce[:, 1]]
    tgt = np.where(cross, 0.18, 0.135)
    wt = np.where(cross, 0.5, 1.0)
    x0 = S[s_of_c] + rng.normal(0, 0.03, (len(counties), 3)) * [1.4, 0.6, 0.6]
    C = solve(x0, ce, tgt, wt, s_of_c, carea, S, family_planes(fam[s_of_c]), None, 2500, 0.008, (0.016, 0.94))
    dc = np.linalg.norm(C[ce[:, 0]] - C[ce[:, 1]], axis=1)
    for nm, mm in (("county within state", ~cross), ("county cross-state", cross)):
        print(nm, mm.sum(), "min/1%/5%/median", np.percentile(dc[mm], [0, 1, 5, 50]).round(3))

    for nm, (nrm, off) in zip(("Lmin", "Lmax", "Cmin", "Cmax", "hlo", "hhi"), family_planes(fam[s_of_c])):
        v = off - (nrm * C).sum(1)
        print("  county violation", nm, v.max().round(3), (v > 0.015).sum())

    # ---- subdivisions
    sc = c_of[edge[:, 0]] != c_of[edge[:, 1]]
    ss = s_of[edge[:, 0]] != s_of[edge[:, 1]]
    tgt = np.where(ss, 0.20, np.where(sc, 0.10, 0.065))
    wt = np.where(ss, 0.5, np.where(sc, 0.8, 1.0)) * np.where(isgap, 0.4, 1.0)
    x0 = C[c_of] + rng.normal(0, 0.02, (n, 3))
    X = solve(x0, edge, tgt, wt, c_of, area, C, family_planes(fam[s_of], 0.03, 2), 0.046, 900, 0.004, (0.003, 0.995))
    single = np.bincount(c_of)[c_of] == 1
    X[single] = C[c_of[single]]
    rgb = to8(X)
    X8 = from8(rgb)
    de = np.linalg.norm(X8[edge[:, 0]] - X8[edge[:, 1]], axis=1)
    t = ~isgap
    for nm, mm in (("sub within county", ~sc), ("sub cross-county", sc & ~ss), ("sub cross-state", ss)):
        print(nm, (mm & t).sum(), "min/1%/5%/median", np.percentile(de[mm & t], [0, 1, 5, 50]).round(3))

    # ---- what the finished 8-bit pixels really average to
    lin = dec(rgb / 255.0)
    cm = lin2lab(np.stack([np.bincount(c_of, area * c) for c in lin.T], 1) / carea[:, None])
    sm = lin2lab(np.stack([np.bincount(s_of, area * c) for c in lin.T], 1) / sarea[:, None])
    ec = np.linalg.norm(cm - C, axis=1)
    print("mean error: county max", ec.max().round(4), "p99", np.percentile(ec, 99).round(4),
          "state max", np.linalg.norm(sm - S, axis=1).max().round(4))
    np.savez(out, rgb=rgb, county_rgb=to8(cm), state_rgb=to8(sm), fam=fam, states=states, counties=counties,
             s_of_c=s_of_c, c_of=c_of, s_of=s_of, cm=cm, sm=sm, C=C, S=S, spairs=spairs, ce=ce, cross=cross, sc=sc, ss=ss,
             family_names=np.array([a[0] for a in FAMILIES]))


main(*sys.argv[1:3])
