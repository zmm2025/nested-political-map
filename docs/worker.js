/* Decodes map.bin off the main thread. Sends one light mesh of the whole map, then
   builds full-detail meshes one state at a time when the page asks for them. */
importScripts('vendor/earcut.min.js');
const cut = earcut.default;
const COARSE_KM = 0.3;   // border error allowed in the light mesh

let nUnits, rgb, shape, refs, shapeAt, refAt, county, countyState, full, light;

function reader(bytes) {
  let i = 0;
  const u = () => {
    let v = 0, m = 1, b;
    do { b = bytes[i++]; v += (b & 127) * m; m *= 128; } while (b & 128);
    return v;
  };
  return { u, s: () => { const v = u(); return v % 2 ? -(v + 1) / 2 : v / 2; }, more: () => i < bytes.length };
}

// Douglas-Peucker on one arc. Arcs are shared by both neighbors, so both sides stay glued.
function thin(xy, a, b, tol, keep) {
  const stack = [];
  const closed = xy[a * 2] === xy[(b - 1) * 2] && xy[a * 2 + 1] === xy[(b - 1) * 2 + 1];
  keep[a] = keep[b - 1] = 1;
  if (closed && b - a > 3) {   // split a loop at its farthest point, then at the middle of each half
    let far = a, best = -1;
    for (let i = a + 1; i < b - 1; i++) {
      const d = (xy[i * 2] - xy[a * 2]) ** 2 + (xy[i * 2 + 1] - xy[a * 2 + 1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    keep[far] = 1;
    stack.push(a, far, far, b - 1);
  } else stack.push(a, b - 1);
  while (stack.length) {
    const e = stack.pop(), s = stack.pop();
    if (e - s < 2) continue;
    const x0 = xy[s * 2], y0 = xy[s * 2 + 1], dx = xy[e * 2] - x0, dy = xy[e * 2 + 1] - y0, l2 = dx * dx + dy * dy;
    let best = tol * tol, at = -1;
    for (let i = s + 1; i < e; i++) {
      const px = xy[i * 2] - x0, py = xy[i * 2 + 1] - y0;
      let t = l2 ? (px * dx + py * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > best) { best = d; at = i; }
    }
    if (at > 0) { keep[at] = 1; stack.push(s, at, at, e); }
  }
}

// triangulate units [from, to) from one set of arcs
function mesh(from, to, arcs, guess) {
  const { xy, off } = arcs;
  let cap = guess, icap = guess * 3, nv = 0, ni = 0;
  let pos = new Float32Array(cap * 2), col = new Uint8Array(cap * 4), idx = new Uint32Array(icap);
  const start = new Uint32Array(to - from + 1);
  const flat = [], holes = [];
  for (let u = from; u < to; u++) {
    start[u - from] = ni;
    let s = shapeAt[u], q = refAt[u];
    const r = rgb[u * 3], g = rgb[u * 3 + 1], b = rgb[u * 3 + 2];
    for (let np = shape[s++]; np > 0; np--) {
      flat.length = holes.length = 0;
      for (let nr = shape[s++], k = 0; k < nr; k++) {
        if (k) holes.push(flat.length / 2);
        for (let na = shape[s++]; na > 0; na--) {
          const ref = refs[q++], a = ref < 0 ? ~ref : ref, p0 = off[a], p1 = off[a + 1];
          if (ref < 0) for (let i = p1 - 1; i > p0; i--) flat.push(xy[i * 2], xy[i * 2 + 1]);
          else for (let i = p0; i < p1 - 1; i++) flat.push(xy[i * 2], xy[i * 2 + 1]);
        }
      }
      const m = flat.length / 2;
      if (m < 3) continue;
      const tri = cut(flat, holes);
      if (nv + m > cap) {
        cap = Math.ceil(Math.max(cap * 1.4, nv + m));
        const p2 = new Float32Array(cap * 2), c2 = new Uint8Array(cap * 4);
        p2.set(pos); c2.set(col); pos = p2; col = c2;
      }
      if (ni + tri.length > icap) {
        icap = Math.ceil(Math.max(icap * 1.4, ni + tri.length));
        const i2 = new Uint32Array(icap);
        i2.set(idx); idx = i2;
      }
      for (let k = 0; k < m; k++) {
        const v = nv + k;
        pos[v * 2] = flat[k * 2]; pos[v * 2 + 1] = flat[k * 2 + 1];
        col[v * 4] = r; col[v * 4 + 1] = g; col[v * 4 + 2] = b; col[v * 4 + 3] = 255;
      }
      for (let k = 0; k < tri.length; k++) idx[ni++] = nv + tri[k];
      nv += m;
    }
  }
  start[to - from] = ni;
  return { from, to, pos: pos.slice(0, nv * 2), col: col.slice(0, nv * 4), idx: idx.slice(0, ni), start };
}
const buffers = (m) => [m.pos.buffer, m.col.buffer, m.idx.buffer, m.start.buffer];

// phones drop connections; a half-finished download is simply started again
async function download() {
  for (let n = 0; ; n++) {
    try {
      const res = await fetch('map.bin', n ? { cache: 'reload' } : {});
      if (!res.ok) throw new Error('map.bin: HTTP ' + res.status);
      return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } catch (e) {
      if (n >= 4 || typeof DecompressionStream === 'undefined') throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** n));
    }
  }
}

async function load() {
  const buf = await download();
  const head = new DataView(buf);
  const Q = head.getUint32(0, true), nArcs = head.getUint32(8, true), nSec = head.getUint32(12, true);
  nUnits = head.getUint32(4, true);
  const secs = [];
  for (let k = 0, o = 16 + nSec * 4; k < nSec; k++) {
    const len = head.getUint32(16 + k * 4, true);
    secs.push(new Uint8Array(buf, o, len));
    o += len;
  }
  const meta = JSON.parse(new TextDecoder().decode(secs[0]));
  countyState = meta.countyState;
  rgb = secs[5].slice();

  const off = new Uint32Array(nArcs + 1);
  { const r = reader(secs[1]); for (let a = 0; a < nArcs; a++) off[a + 1] = off[a] + r.u(); }
  const total = off[nArcs], xy = new Float32Array(total * 2);
  { const r = reader(secs[2]); let x = 0, y = 0;
    for (let i = 0; i < total; i++) { x += r.s(); y += r.s(); xy[i * 2] = x / Q; xy[i * 2 + 1] = y / Q; } }
  full = { xy, off };

  { const r = reader(secs[3]), out = []; while (r.more()) out.push(r.u()); shape = Uint32Array.from(out); }
  { const r = reader(secs[4]), out = []; let last = 0; while (r.more()) { last += r.s(); out.push(last); } refs = Int32Array.from(out); }
  county = new Uint16Array(nUnits);
  { const r = reader(secs[8]); let c = 0; for (let u = 0; u < nUnits; u++) county[u] = c += r.s(); }

  // where each unit starts, plus its exact box and area
  shapeAt = new Uint32Array(nUnits); refAt = new Uint32Array(nUnits);
  const box = new Float32Array(nUnits * 4), area = new Float32Array(nUnits);
  for (let u = 0, s = 0, q = 0; u < nUnits; u++) {
    shapeAt[u] = s; refAt[u] = q;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, sum = 0;
    for (let np = shape[s++]; np > 0; np--) for (let nr = shape[s++], k = 0; k < nr; k++) {
      let ring = 0;
      for (let na = shape[s++]; na > 0; na--) {
        const ref = refs[q++], a = ref < 0 ? ~ref : ref;
        let part = 0;
        for (let i = off[a] + 1; i < off[a + 1]; i++) {
          const px = xy[i * 2 - 2], py = xy[i * 2 - 1], x = xy[i * 2], y = xy[i * 2 + 1];
          part += px * y - x * py;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        ring += ref < 0 ? -part : part;
      }
      sum += (k ? -1 : 1) * Math.abs(ring) / 2;
    }
    box.set([x0, y0, x1, y1], u * 4); area[u] = sum;
  }

  const keep = new Uint8Array(total), loff = new Uint32Array(nArcs + 1);
  for (let a = 0; a < nArcs; a++) thin(xy, off[a], off[a + 1], COARSE_KM, keep);
  let n = 0;
  for (let i = 0; i < total; i++) n += keep[i];
  const lxy = new Float32Array(n * 2);
  for (let a = 0, j = 0; a < nArcs; a++) {
    for (let i = off[a]; i < off[a + 1]; i++) if (keep[i]) { lxy[j * 2] = xy[i * 2]; lxy[j * 2 + 1] = xy[i * 2 + 1]; j++; }
    loff[a + 1] = j;
  }
  const coarse = mesh(0, nUnits, { xy: lxy, off: loff }, 1 << 19);
  const out = { type: 'map', meta, nUnits, coarse, box, area, county: county.slice(), rgb: rgb.slice(), countyRgb: secs[6].slice(), stateRgb: secs[7].slice() };
  postMessage(out, [...buffers(coarse), ...[box, area, out.county, out.rgb, out.countyRgb, out.stateRgb].map((a) => a.buffer)]);
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') return await load();
    const { state } = data;
    let from = 0, to;
    while (countyState[county[from]] !== state) from++;
    for (to = from; to < nUnits && countyState[county[to]] === state; to++);
    const m = mesh(from, to, full, 40000);
    postMessage({ type: 'state', state, mesh: m }, buffers(m));
  } catch (e) {
    postMessage({ type: 'error', error: String((e && e.message) || e) });
  }
};
