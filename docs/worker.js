/* Decodes map.bin and triangulates every polygon, off the main thread. */
importScripts('vendor/earcut.min.js');
const cut = earcut.default;

function reader(bytes) {
  let i = 0;
  const u = () => {
    let v = 0, m = 1, b;
    do { b = bytes[i++]; v += (b & 127) * m; m *= 128; } while (b & 128);
    return v;
  };
  return { u, s: () => { const v = u(); return v % 2 ? -(v + 1) / 2 : v / 2; } };
}

async function inflate(res) {
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

onmessage = async () => {
  try {
    const res = await fetch('map.bin');
    if (!res.ok) throw new Error('map.bin: HTTP ' + res.status);
    const buf = await inflate(res);
    const head = new DataView(buf);
    const Q = head.getUint32(0, true), nUnits = head.getUint32(4, true), nArcs = head.getUint32(8, true), nSec = head.getUint32(12, true);
    const secs = [];
    let o = 16 + nSec * 4;
    for (let k = 0; k < nSec; k++) {
      const len = head.getUint32(16 + k * 4, true);
      secs.push(new Uint8Array(buf, o, len));
      o += len;
    }
    const meta = JSON.parse(new TextDecoder().decode(secs[0]));

    const arcs = [];
    let x = 0, y = 0;
    const rl = reader(secs[1]), rp = reader(secs[2]);
    for (let a = 0; a < nArcs; a++) {
      const n = rl.u(), p = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) { x += rp.s(); y += rp.s(); p[k * 2] = x / Q; p[k * 2 + 1] = y / Q; }
      arcs.push(p);
    }

    const rgb = secs[5], rs = reader(secs[3]), rr = reader(secs[4]), rc = reader(secs[8]);
    let cap = 1 << 21, nv = 0, ni = 0;
    let pos = new Float32Array(cap * 2), col = new Uint8Array(cap * 4), idx = new Uint32Array(cap * 4);
    const start = new Uint32Array(nUnits + 1), box = new Float32Array(nUnits * 4), area = new Float32Array(nUnits), county = new Uint16Array(nUnits);
    let last = 0, cty = 0;
    for (let u = 0; u < nUnits; u++) {
      start[u] = ni;
      cty += rc.s(); county[u] = cty;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, ar = 0;
      const r = rgb[u * 3], g = rgb[u * 3 + 1], b = rgb[u * 3 + 2];
      for (let np = rs.u(); np > 0; np--) {
        const flat = [], holes = [];
        for (let nr = rs.u(), k = 0; k < nr; k++) {
          if (k) holes.push(flat.length / 2);
          for (let na = rs.u(); na > 0; na--) {
            last += rr.s();
            const p = arcs[last < 0 ? ~last : last], n = p.length / 2;
            if (last < 0) for (let q = n - 1; q > 0; q--) flat.push(p[q * 2], p[q * 2 + 1]);
            else for (let q = 0; q < n - 1; q++) flat.push(p[q * 2], p[q * 2 + 1]);
          }
        }
        const tri = cut(flat, holes), m = flat.length / 2;
        if (nv + m > cap) {
          cap = Math.ceil(Math.max(cap * 1.5, nv + m));
          const p2 = new Float32Array(cap * 2), c2 = new Uint8Array(cap * 4);
          p2.set(pos); c2.set(col); pos = p2; col = c2;
        }
        if (ni + tri.length > idx.length) {
          const i2 = new Uint32Array(Math.ceil(Math.max(idx.length * 1.5, ni + tri.length)));
          i2.set(idx); idx = i2;
        }
        for (let k = 0; k < m; k++) {
          const px = flat[k * 2], py = flat[k * 2 + 1], v = nv + k;
          pos[v * 2] = px; pos[v * 2 + 1] = py;
          col[v * 4] = r; col[v * 4 + 1] = g; col[v * 4 + 2] = b; col[v * 4 + 3] = 255;
          if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
        for (let k = 0; k < tri.length; k += 3) {
          const a = tri[k], c = tri[k + 1], d = tri[k + 2];
          ar += Math.abs((flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[d * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1])) / 2;
          idx[ni++] = nv + a; idx[ni++] = nv + c; idx[ni++] = nv + d;
        }
        nv += m;
      }
      box.set([x0, y0, x1, y1], u * 4); area[u] = ar;
    }
    start[nUnits] = ni;
    pos = pos.slice(0, nv * 2); col = col.slice(0, nv * 4); idx = idx.slice(0, ni);
    const out = {
      meta, nUnits, pos, col, idx, start, box, area, county,
      rgb: rgb.slice(), countyRgb: secs[6].slice(), stateRgb: secs[7].slice(),
    };
    postMessage(out, [pos, col, idx, start, box, area, county, out.rgb, out.countyRgb, out.stateRgb].map((a) => a.buffer));
  } catch (e) {
    postMessage({ error: String((e && e.message) || e) });
  }
};
