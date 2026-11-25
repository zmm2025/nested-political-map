"""Read Census cartographic boundary county subdivisions, project every state
into one flat US layout (equal-area, kilometres, y down) and write GeoJSON.

usage: python prep.py <cousub.shp> <county.shp> <state.shp> <out.geojson> <out-names.json>
"""
import json, sys
import numpy as np
import shapefile

cousub, county, state, out, out_names = sys.argv[1:6]
R = 6371.0


def albers(lon, lat, lon0, lat0, p1, p2):
    """Spherical Albers equal-area conic -> km, y down."""
    lon = (np.asarray(lon) - lon0 + 540) % 360 - 180
    r = np.pi / 180
    s1, s2 = np.sin(p1 * r), np.sin(p2 * r)
    n = (s1 + s2) / 2
    c = np.cos(p1 * r) ** 2 + 2 * n * s1
    rho = R / n * np.sqrt(c - 2 * n * np.sin(np.asarray(lat) * r))
    rho0 = R / n * np.sqrt(c - 2 * n * np.sin(lat0 * r))
    th = n * lon * r
    return rho * np.sin(th), -(rho0 - rho * np.cos(th))


# group -> (projection, scale, (x, y) of the projection origin in the layout)
GROUPS = {
    "48": ((-96, 37.5, 29.5, 45.5), 1.0, (0, 0)),
    "AK": ((-154, 63, 55, 65), 0.35, (-1620, 1330)),
    "HI": ((-157.5, 20.7, 8, 18), 1.0, (-640, 1500)),
    "PR": ((-66.2, 18.15, 17, 19), 1.5, (1690, 1640)),
    "GU": ((145.0, 14.3, 13, 16), 1.0, (370, 1640)),
    "AS": ((-170.2, -14.25, -16, -12), 1.5, (770, 1640)),
}
GROUP_OF = {"02": "AK", "15": "HI", "72": "PR", "78": "PR", "66": "GU", "69": "GU", "60": "AS"}


def main():
    cos = {}
    for rec in shapefile.Reader(county, encoding="utf-8").iterRecords():
        d = rec.as_dict()
        cos[d["GEOID"]] = d["NAMELSAD"]
    sts = {}
    for rec in shapefile.Reader(state, encoding="utf-8").iterRecords():
        d = rec.as_dict()
        sts[d["STATEFP"]] = (d["NAME"], d["STUSPS"])

    subs, feats, skipped = {}, [], []
    for sr in shapefile.Reader(cousub, encoding="utf-8").iterShapeRecords():
        d = sr.record.as_dict()
        if not sr.shape.points:
            skipped.append(d["GEOID"]); continue
        (lon0, lat0, p1, p2), k, (ox, oy) = GROUPS[GROUP_OF.get(d["STATEFP"], "48")]
        p = np.array(sr.shape.points)[:, :2]
        if d["STATEFP"] == "15" and p[:, 0].min() < -161:
            # Honolulu County also owns a 1,900 km tail of uninhabited atolls.
            parts = list(sr.shape.parts) + [len(p)]
            keep = [p[a:b] for a, b in zip(parts, parts[1:]) if p[a:b, 0].min() > -161]
            if not keep:
                skipped.append(d["GEOID"]); continue
            sr.shape.parts = np.cumsum([0] + [len(k) for k in keep])[:-1].tolist()
            p = np.concatenate(keep)
        x, y = albers(p[:, 0], p[:, 1], lon0, lat0, p1, p2)
        sr.shape.points = np.round(np.c_[x * k + ox, -(y * k + oy)], 5).tolist()
        # pyshp tells holes from shells by winding, so flip y only afterwards.
        geom = sr.shape.__geo_interface__
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        geom = {"type": "MultiPolygon", "coordinates": [[[(a, -b) for a, b in ring] for ring in poly] for poly in polys]}
        feats.append({"type": "Feature", "properties": {"g": d["GEOID"]}, "geometry": geom})
        subs[d["GEOID"]] = d["NAMELSAD"]
    json.dump({"type": "FeatureCollection", "features": feats}, open(out, "w"))
    json.dump({"states": sts, "counties": cos, "subs": subs}, open(out_names, "w", encoding="utf-8"), ensure_ascii=False)
    used = {g[:5] for g in subs}
    print(len(subs), "subdivisions;", len(used), "counties used;", len(cos), "counties listed;", len(sts), "states; skipped", skipped)
    print("counties with no subdivision:", set(cos) - used, "unknown:", used - set(cos))


main()
