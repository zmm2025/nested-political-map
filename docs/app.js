// Every town has one fixed color. Nothing here reads the zoom level when it picks a
// color: zooming only moves the camera.
//
// What gets drawn is chosen to keep memory small and steady, because phones kill tabs
// that are greedy with graphics memory:
//   far      one picture of the whole map, averaged in linear light
//   middle   one light mesh of the whole map
//   close    full-detail meshes, only for the states on screen, oldest dropped first
// Nothing is allocated per frame, and the canvas is the only full-size buffer.
const $ = (id) => document.getElementById(id);
const canvas = $('map'), backup = $('flat'), stage = $('stage'), status = $('status'), about = $('about');

const PICTURE = [-2460, -1650, 2340, 1806];   // km, what the picture covers
const LAND = [-2376, -1566, 2252, 1761];      // km, what the first view must show
const BG = [236, 237, 239];
const MAX_K = 64;                             // closer than this, the borders run out of detail
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

// If the last visit ended without the page being closed or hidden, the browser probably
// killed it. Come back in a lighter mode at the first view instead of straight into it.
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* private mode */ } } };
let lite = store.get('running') === '1';
const running = () => store.set('running', document.visibilityState === 'visible' ? '1' : '');
running();
addEventListener('pagehide', () => store.set('running', ''));
addEventListener('pageshow', running);

const touchy = matchMedia('(pointer: coarse)').matches;
const maxDpr = () => (lite ? 1.25 : touchy ? 2 : 3);
const fineBudget = () => (lite ? 10 : touchy ? 36 : 140) * 1048576;
const PICTURE_UNTIL = 0.5;                    // device px per km; the picture's own resolution
const FINE_FROM = 2.4;                        // beyond this the light mesh's shortcuts would show

let W = 0, H = 0, dpr = 1, atHome = true;
const cam = { x: 0, y: 0, k: 1 };             // center in km, CSS px per km
let data = null, queued = false, flight = 0, flyGoal = null;

// ---------------------------------------------------------------- camera
// space the header and controls need around the first view
const pads = () => (W <= 640 ? { top: 128, bottom: 76, side: 10 } : H < 480 ? { top: 8, bottom: 8, side: 150 } : { top: 76, bottom: 28, side: 28 });
function fitScale() {
  const p = pads();
  return Math.max(0.01, Math.min((W - p.side * 2) / (LAND[2] - LAND[0]), (H - p.top - p.bottom) / (LAND[3] - LAND[1])));
}
const home = () => { const k = fitScale(), p = pads(); return { x: (LAND[0] + LAND[2]) / 2, y: (LAND[1] + LAND[3]) / 2 - (p.top - p.bottom) / 2 / k, k }; };
// distances at which each level is the thing you see
const LEVELS = { far: () => fitScale() * 0.16, state: fitScale, county: () => Math.max(0.95, fitScale() * 2.6), town: () => 6 };
const clampK = (k) => Math.min(MAX_K, Math.max(fitScale() * 0.06, k));

function clampCam() {
  cam.k = clampK(cam.k);
  cam.x = Math.min(LAND[2], Math.max(LAND[0], cam.x));
  cam.y = Math.min(LAND[3], Math.max(LAND[1], cam.y));
}
const worldAt = (px, py) => [cam.x + (px - W / 2) / cam.k, cam.y + (py - H / 2) / cam.k];
// put world point w under screen point (px, py) at scale k
function pin(w, px, py, k) {
  cam.k = clampK(k);
  cam.x = w[0] - (px - W / 2) / cam.k;
  cam.y = w[1] - (py - H / 2) / cam.k;
  clampCam(); atHome = false; changed();
}
const zoomAt = (px, py, f) => pin(worldAt(px, py), px, py, cam.k * f);
function stopFlight() { cancelAnimationFrame(flight); flight = 0; flyGoal = null; }
function flyTo(t, toHome = false) {
  stopFlight();
  const a = { ...cam };
  t = { x: t.x, y: t.y, k: clampK(t.k) };
  flyGoal = t; atHome = toHome;
  const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650, t0 = performance.now();
  const step = (now) => {
    const u = ms ? Math.min(1, Math.max(0, (now - t0) / ms)) : 1, e = u < 0.5 ? 4 * u * u * u : 1 - (2 - 2 * u) ** 3 / 2;
    cam.k = a.k * (t.k / a.k) ** e;
    // keep the on-screen path straight while the scale changes exponentially
    const s = Math.abs(Math.log(t.k / a.k)) < 1e-4 ? e : (1 / cam.k - 1 / a.k) / (1 / t.k - 1 / a.k);
    cam.x = a.x + (t.x - a.x) * s; cam.y = a.y + (t.y - a.y) * s;
    changed();
    if (u < 1) flight = requestAnimationFrame(step); else { flight = 0; flyGoal = null; }
  };
  if (ms) flight = requestAnimationFrame(step); else step(t0);
}
let hashTimer = 0;
const levelButtons = [...document.querySelectorAll('[data-level]')];
function changed() {
  if (!queued) { queued = true; requestAnimationFrame(frame); }
  clearTimeout(hashTimer);
  if (data) hashTimer = setTimeout(saveView, 500);
}
function saveView() {
  if (pts.size || flight) return;
  // Safari throws if this is called too often
  try { history.replaceState(null, '', atHome ? location.pathname + location.search : `#${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.k.toPrecision(3)}`); } catch { /* keep the old address */ }
}
function frame() {
  queued = false;
  for (const b of levelButtons) {
    const on = Math.abs(Math.log(cam.k / LEVELS[b.dataset.level]())) < 0.12 ? 'true' : 'false';
    if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
  }
  placeLabels();
  draw();
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  const d = Math.min(maxDpr(), window.devicePixelRatio || 1);
  if (w === W && h === H && d === dpr) return;
  W = w; H = h; dpr = d;
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  for (const c of [canvas, backup]) if (!c.hidden && (c.width !== pw || c.height !== ph)) { c.width = pw; c.height = ph; }
  if (atHome && !flight) Object.assign(cam, home());
  clampCam();
  anchor();
  // setting a canvas size blanks it, so repaint before the browser shows it
  frame();
}

// insets sit in open water, far from where they really are, so they get names
const labels = [['Guam and Northern Marianas', 350, 1705], ['American Samoa', 860, 1705], ['Puerto Rico and U.S. Virgin Islands', 1660, 1705]].map(([t, x, y]) => {
  const el = document.createElement('span');
  el.className = 'inset'; el.textContent = t; stage.insertBefore(el, document.querySelector('.title'));
  return { el, x, y };
});
function placeLabels() {
  for (const { el, x, y } of labels) {
    const px = W / 2 + (x - cam.x) * cam.k, py = H / 2 + (y - cam.y) * cam.k + 8;
    const show = cam.k > 0.16 && cam.k < 4 && px > -80 && px < W + 80 && py > -40 && py < H + 40;
    if (el.hidden === show) el.hidden = !show;
    if (show) el.style.transform = `translate(${px}px, ${py}px) translateX(-50%)`;
  }
}

// ---------------------------------------------------------------- drawing
const VS = `#version 300 es
layout(location=0) in vec2 p; layout(location=1) in vec4 c;
uniform vec4 cam; flat out vec3 v;
void main(){ gl_Position = vec4((p - cam.xy) * cam.zw, 0., 1.); v = c.rgb; }`;
const FS = `#version 300 es
precision mediump float; flat in vec3 v; out vec4 o; void main(){ o = vec4(v, 1.); }`;
const VS2 = `#version 300 es
uniform vec4 rect; out vec2 uv;
void main(){ vec2 q = vec2(gl_VertexID & 1, gl_VertexID >> 1); uv = vec2(q.x, 1. - q.y); gl_Position = vec4(rect.xy + q * rect.zw, 0., 1.); }`;
// the texture is sRGB, so the hardware averages in linear light; encode back at the end
const FS2 = `#version 300 es
precision highp float; uniform sampler2D t; in vec2 uv; out vec4 o;
void main(){
  vec2 a = dFdx(uv), b = dFdy(uv);
  vec3 l = texture(t, uv + a*.125 + b*.375, -1.).rgb + texture(t, uv - a*.125 - b*.375, -1.).rgb
         + texture(t, uv + a*.375 - b*.125, -1.).rgb + texture(t, uv - a*.375 + b*.125, -1.).rgb;
  l *= .25;
  o = vec4(mix(1.055 * pow(max(l, vec3(1e-6)), vec3(1./2.4)) - 0.055, l * 12.92, lessThanEqual(l, vec3(0.0031308))), 1.);
}`;

const picture = new Image();
picture.decoding = 'async';
let gl = null, gpu = null, flat2d = null, losses = 0, fineBytes = 0, tick = 0, waiting = -1;
const fine = new Map();                       // state -> full-detail mesh

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) || 'shader failed');
  return p;
}
function upload(m) {
  const vao = gl.createVertexArray(), bufs = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs[0]); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs[1]); gl.bufferData(gl.ARRAY_BUFFER, m.col, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs[2]); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  m.vao = vao; m.bufs = bufs;
}
function release(m) {
  if (gl && m.vao && !gl.isContextLost()) { gl.deleteVertexArray(m.vao); m.bufs.forEach((b) => gl.deleteBuffer(b)); }
  m.vao = m.bufs = null;
}
function initGL() {
  // an opaque antialiased canvas comes out blank on some Android drivers, so ask for
  // alpha and simply never draw anything transparent
  gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: false, stencil: false });
  if (!gl || gl.isContextLost()) return false;
  // prove the canvas can hold a color before trusting it
  const px = new Uint8Array(4);
  gl.clearColor(1, 0.5, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (Math.abs(px[0] - 255) + Math.abs(px[1] - 128) + px[2] + Math.abs(px[3] - 255) > 24) return false;
  const mesh = program(VS, FS), quad = program(VS2, FS2);
  gpu = { mesh, quad, cam: gl.getUniformLocation(mesh, 'cam'), rect: gl.getUniformLocation(quad, 'rect'), empty: gl.createVertexArray(), tex: null };
  gl.disable(gl.DEPTH_TEST);
  if (picture.complete && picture.naturalWidth) uploadPicture();
  if (data) upload(data.coarse);
  return true;
}
function uploadPicture() {
  gpu.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, picture);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// plain 2D drawing of the picture, for when WebGL is missing or the browser took it away
function drawFlat() {
  if (!flat2d) return;
  const g = flat2d, w = backup.width, h = backup.height, k = cam.k * dpr, s = picture.naturalWidth / (PICTURE[2] - PICTURE[0]);
  g.fillStyle = `rgb(${BG})`; g.fillRect(0, 0, w, h);
  if (!picture.naturalWidth) return;
  // only ever touch the part of the picture that is on screen
  const x0 = Math.max(PICTURE[0], cam.x - w / 2 / k), x1 = Math.min(PICTURE[2], cam.x + w / 2 / k);
  const y0 = Math.max(PICTURE[1], cam.y - h / 2 / k), y1 = Math.min(PICTURE[3], cam.y + h / 2 / k);
  if (x1 <= x0 || y1 <= y0) return;
  g.imageSmoothingEnabled = k < s; g.imageSmoothingQuality = 'high';
  g.drawImage(picture, (x0 - PICTURE[0]) * s, (y0 - PICTURE[1]) * s, (x1 - x0) * s, (y1 - y0) * s,
    w / 2 + (x0 - cam.x) * k, h / 2 + (y0 - cam.y) * k, (x1 - x0) * k, (y1 - y0) * k);
}
function showFlat(on) {
  if (backup.hidden !== on) return;
  backup.hidden = !on;
  if (on) { backup.width = Math.round(W * dpr); backup.height = Math.round(H * dpr); flat2d = backup.getContext('2d', { alpha: false }); }
  else { backup.width = backup.height = 1; flat2d = null; }
}

function drawRange(m, inView) {
  // m covers units [from, to); draw the visible counties, merging neighbors in the list
  const { cfirst, county } = data, { start, from, to } = m;
  gl.bindVertexArray(m.vao);
  let open = -1;
  for (let c = county[from], end = county[to - 1]; c <= end + 1; c++) {
    const seen = c <= end && inView(c);
    const at = start[Math.min(to, cfirst[c]) - from];
    if (seen && open < 0) open = at;
    if (!seen && open >= 0) {
      if (at > open) gl.drawElements(gl.TRIANGLES, at - open, gl.UNSIGNED_INT, open * 4);
      open = -1;
    }
  }
}
function draw() {
  if (!W) return;
  if (!gpu) { drawFlat(); return; }
  const cw = canvas.width, ch = canvas.height, k = cam.k * dpr, hw = cw / 2 / k, hh = ch / 2 / k;
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(BG[0] / 255, BG[1] / 255, BG[2] / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const meshReady = data && data.coarse.vao;
  if (k <= PICTURE_UNTIL || !meshReady) {
    if (!gpu.tex) return;
    gl.useProgram(gpu.quad); gl.bindVertexArray(gpu.empty); gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
    gl.uniform4f(gpu.rect, (PICTURE[0] - cam.x) / hw, (cam.y - PICTURE[3]) / hh, (PICTURE[2] - PICTURE[0]) / hw, (PICTURE[3] - PICTURE[1]) / hh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return;
  }
  const { cbox, sbox } = data;
  const hit = (b, i) => b[i * 4] < cam.x + hw && b[i * 4 + 2] > cam.x - hw && b[i * 4 + 1] < cam.y + hh && b[i * 4 + 3] > cam.y - hh;
  const inView = (c) => hit(cbox, c);
  gl.useProgram(gpu.mesh);
  gl.uniform4f(gpu.cam, cam.x, cam.y, 1 / hw, -1 / hh);
  if (k < FINE_FROM) { drawRange(data.coarse, inView); return; }
  tick++;
  const want = [];
  for (let s = 0; s < data.meta.states.length; s++) if (hit(sbox, s) && data.stateCounties[s].some(inView)) want.push(s);
  let missing = -1, best = Infinity;
  for (const s of want) {
    const m = fine.get(s);
    if (m) { m.used = tick; continue; }
    const dx = Math.max(sbox[s * 4] - cam.x, 0, cam.x - sbox[s * 4 + 2]), dy = Math.max(sbox[s * 4 + 1] - cam.y, 0, cam.y - sbox[s * 4 + 3]);
    if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; missing = s; }
  }
  // the light mesh stays underneath until every state on screen has its detail
  if (missing >= 0) drawRange(data.coarse, inView);
  for (const s of want) if (fine.has(s)) drawRange(fine.get(s), inView);
  if (missing >= 0) request(missing);
}
const bytes = (m) => m.pos.byteLength + m.col.byteLength + m.idx.byteLength;
function request(s) {
  if (waiting >= 0 || lite === 'off') return;
  makeRoom(0);
  if (fineBytes > fineBudget()) return;       // everything loaded is on screen; stay with the light mesh
  waiting = s;
  worker.postMessage({ type: 'state', state: s });
}
function makeRoom(extra) {
  const idle = [...fine].filter(([, m]) => m.used < tick).sort((a, b) => a[1].used - b[1].used);
  while (fineBytes + extra > fineBudget() && idle.length) drop(idle.shift()[0]);
}
function drop(s) {
  const m = fine.get(s);
  fine.delete(s); fineBytes -= bytes(m); release(m);
}
function gotState(s, m) {
  waiting = -1;
  if (!gpu) return;
  makeRoom(bytes(m));
  m.used = tick;
  upload(m);
  fine.set(s, m); fineBytes += bytes(m);
  changed();
}

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();                         // ask the browser to give it back
  gpu = null; losses++;
  for (const m of fine.values()) m.vao = m.bufs = null;
  fine.clear(); fineBytes = 0; waiting = -1;
  if (data) data.coarse.vao = data.coarse.bufs = null;
  if (losses > 1) lite = true;                // it is struggling: ask for less from now on
  showFlat(true); draw();
});
canvas.addEventListener('webglcontextrestored', () => {
  try { if (losses < 5 && initGL()) { if (lite) { W = 0; resize(); } showFlat(false); } } catch { gpu = null; }
  changed();
});
document.addEventListener('visibilitychange', () => {
  running();
  if (document.hidden) { letGo(); for (const s of [...fine.keys()]) drop(s); }   // hand memory back in the background
  else changed();
});

// ---------------------------------------------------------------- what is under the pointer
function indexUnits() {
  const { box, county, nUnits, meta } = data, nc = meta.counties.length, ns = meta.states.length;
  const empty = (n) => new Float32Array(n * 4).map((_, i) => (i % 4 < 2 ? 1e9 : -1e9));
  const cbox = empty(nc), sbox = empty(ns), cfirst = new Uint32Array(nc + 2).fill(nUnits), stateCounties = Array.from({ length: ns }, () => []);
  const grow = (b, i, x0, y0, x1, y1) => { i *= 4; b[i] = Math.min(b[i], x0); b[i + 1] = Math.min(b[i + 1], y0); b[i + 2] = Math.max(b[i + 2], x1); b[i + 3] = Math.max(b[i + 3], y1); };
  for (let u = nUnits - 1; u >= 0; u--) {
    const c = county[u], b = box.subarray(u * 4, u * 4 + 4);
    cfirst[c] = u;
    grow(cbox, c, ...b); grow(sbox, meta.countyState[c], ...b);
  }
  meta.countyState.forEach((s, c) => stateCounties[s].push(c));
  Object.assign(data, { cbox, sbox, cfirst, stateCounties });
}
function unitAt(x, y) {
  const { cbox, cfirst, box, meta, coarse } = data;
  for (let c = 0; c < meta.counties.length; c++) {
    const o = c * 4;
    if (x < cbox[o] || x > cbox[o + 2] || y < cbox[o + 1] || y > cbox[o + 3]) continue;
    const { start, idx, pos, from } = fine.get(meta.countyState[c]) || coarse;
    for (let u = cfirst[c]; u < cfirst[c + 1]; u++) {
      const q = u * 4;
      if (x < box[q] || x > box[q + 2] || y < box[q + 1] || y > box[q + 3]) continue;
      for (let i = start[u - from], end = start[u - from + 1]; i < end; i += 3) {
        const a = idx[i] * 2, b = idx[i + 1] * 2, d = idx[i + 2] * 2;
        const s1 = (pos[b] - pos[a]) * (y - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (x - pos[a]);
        const s2 = (pos[d] - pos[b]) * (y - pos[b + 1]) - (pos[d + 1] - pos[b + 1]) * (x - pos[b]);
        const s3 = (pos[a] - pos[d]) * (y - pos[d + 1]) - (pos[a + 1] - pos[d + 1]) * (x - pos[d]);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return u;
      }
    }
  }
  return -1;
}
const css = (a, i) => `rgb(${a[i * 3]} ${a[i * 3 + 1]} ${a[i * 3 + 2]})`;
let lastState = -1;
function identify(px, py) {
  if (!data) return;
  const u = unitAt(...worldAt(px, py));
  $('readout').hidden = u < 0;
  if (u < 0) return;
  const c = data.county[u], s = data.meta.countyState[c];
  lastState = s;
  $('r2').textContent = data.meta.subs[u];
  $('r1').textContent = data.meta.counties[c];
  $('r0').textContent = data.meta.states[s][0];
  $('n0').style.fill = css(data.stateRgb, s); $('n1').style.fill = css(data.countyRgb, c); $('n2').style.fill = css(data.rgb, u);
}

// ---------------------------------------------------------------- input
// Each gesture is measured from where it began, never added up step by step, so a
// dropped or repeated event cannot make the map drift or jump.
const pts = new Map();
let grip = null, moved = 0, lastTap = { t: 0, x: 0, y: 0 }, hover = 0;
const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function anchor() {
  const p = [...pts.values()];
  if (!p.length) { grip = null; return; }
  const [a, b = a] = p, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  grip = { w: worldAt(mx, my), k: cam.k, d: p.length > 1 ? Math.max(12, Math.hypot(a[0] - b[0], a[1] - b[1])) : 0 };
}
function follow() {
  if (!grip) return;
  const [a, b = a] = [...pts.values()];
  const k = grip.d ? grip.k * Math.max(12, Math.hypot(a[0] - b[0], a[1] - b[1])) / grip.d : grip.k;
  pin(grip.w, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, k);
}
function letGo() { pts.clear(); grip = null; canvas.classList.remove('drag'); }

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.isPrimary) pts.clear();               // a new first finger means any older one is stale
  if (pts.size >= 2) return;
  stopFlight();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* already gone */ }
  pts.set(e.pointerId, local(e));
  moved = pts.size > 1 ? 99 : 0;
  anchor();
  canvas.classList.add('drag');
});
canvas.addEventListener('pointermove', (e) => {
  const p = local(e), was = pts.get(e.pointerId);
  if (!was) {
    if (e.pointerType === 'mouse' && !pts.size) { cancelAnimationFrame(hover); hover = requestAnimationFrame(() => identify(...p)); }
    return;
  }
  if (e.pointerType === 'mouse' && !e.buttons) { letGo(); return; }
  if (pts.size === 1 && moved < 8) {          // ignore the jitter of a tap
    moved += Math.hypot(p[0] - was[0], p[1] - was[1]);
    pts.set(e.pointerId, p);
    if (moved >= 8) anchor();
    return;
  }
  pts.set(e.pointerId, p);
  follow();
});
function up(e) {
  if (!pts.has(e.pointerId)) return;
  const tap = e.type === 'pointerup' && pts.size === 1 && moved < 8, p = local(e);
  pts.delete(e.pointerId);
  if (pts.size) { moved = 99; anchor(); return; }
  letGo(); changed();
  if (!tap) return;
  const now = performance.now();
  if (e.pointerType !== 'mouse' && now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 30) {
    lastTap.t = 0; zoomInto(...p, 2.5);
  } else {
    lastTap = { t: now, x: p[0], y: p[1] };
    identify(...p);
  }
}
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(t, up);
addEventListener('blur', letGo);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pts.size) { cancelAnimationFrame(hover); $('readout').hidden = true; } });
function zoomInto(px, py, f) {
  const w = worldAt(px, py), k = clampK(cam.k * f);
  flyTo({ x: w[0] - (px - W / 2) / k, y: w[1] - (py - H / 2) / k, k });
}

// The map owns touches. Without this, phones also run their own page zoom, pull to
// refresh, long-press selection and double-tap zoom, and cancel ours halfway through.
for (const t of ['touchstart', 'touchmove', 'touchend']) canvas.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
stage.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
for (const t of ['contextmenu', 'selectstart', 'dragstart']) stage.addEventListener(t, (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); stopFlight();
  const d = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 400 : 1);
  zoomAt(...local(e), Math.exp(-Math.max(-240, Math.min(240, d)) * (e.ctrlKey ? 0.01 : 0.0022)));
}, { passive: false });
canvas.addEventListener('dblclick', (e) => zoomInto(...local(e), 3));
canvas.addEventListener('keydown', (e) => {
  const step = 90;
  const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (pan) { pin(worldAt(W / 2 + pan[0], H / 2 + pan[1]), W / 2, H / 2, cam.k); identify(W / 2, H / 2); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') { zoomAt(W / 2, H / 2, 1.4); identify(W / 2, H / 2); }
  else if (e.key === '-' || e.key === '_') { zoomAt(W / 2, H / 2, 1 / 1.4); identify(W / 2, H / 2); }
  else if (e.key === '0' || e.key === 'Home') flyTo(home(), true);
});
const nudge = (f) => { const g = flyGoal || cam; flyTo({ x: g.x, y: g.y, k: g.k * f }); };
$('zin').onclick = () => nudge(1.8);
$('zout').onclick = () => nudge(1 / 1.8);
for (const b of levelButtons) b.onclick = () => {
  const l = b.dataset.level, k = LEVELS[l]();
  if (l === 'far' || l === 'state') return flyTo({ ...home(), k }, l === 'state');
  // from the whole country, dive toward a spot where three states meet
  const wide = cam.k < fitScale() * 1.3;
  flyTo({ x: wide ? 560 : cam.x, y: wide ? -40 : cam.y, k });
};

// ---------------------------------------------------------------- the sheet
$('openAbout').onclick = () => { letGo(); about.showModal(); if (data) { $('pick').value = lastState >= 0 ? lastState : $('pick').value; bars(); } };
$('closeAbout').onclick = () => about.close();
about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

function bars() {
  const { meta, area, cfirst } = data, s = +$('pick').value;
  const rows = [[], [], []];
  for (const c of data.stateCounties[s]) {
    let a = 0;
    for (let u = cfirst[c]; u < cfirst[c + 1]; u++) { a += area[u]; rows[2].push([area[u], data.rgb, u]); }
    rows[1].push([a, data.countyRgb, c]);
  }
  rows[0].push([rows[1].reduce((t, r) => t + r[0], 0), data.stateRgb, s]);
  rows.forEach((row, i) => {
    const cv = $('b' + i), w = cv.width = Math.round(cv.clientWidth * dpr), g = cv.getContext('2d'), h = cv.height = Math.round(48 * dpr);
    const total = rows[0][0][0];
    // mix in linear light where several pieces share a pixel column
    const acc = new Float64Array(w * 4);
    let x = 0;
    for (const [a, src, j] of row) {
      const x1 = x + a / total * w, col = [0, 1, 2].map((n) => lin(src[j * 3 + n]));
      for (let p = Math.floor(x); p < Math.min(w, x1); p++) {
        const cover = Math.min(p + 1, x1) - Math.max(p, x);
        for (let n = 0; n < 3; n++) acc[p * 4 + n] += col[n] * cover;
        acc[p * 4 + 3] += cover;
      }
      x = x1;
    }
    for (let p = 0; p < w; p++) {
      const v = [0, 1, 2].map((n) => { const l = acc[p * 4 + n] / (acc[p * 4 + 3] || 1); return Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)); });
      g.fillStyle = `rgb(${v})`; g.fillRect(p, 0, 1, h);
    }
  });
}
function fillSheet() {
  const m = data.meta.metrics, f = (v) => (v * 100).toFixed(1), n = (v) => v.toLocaleString('en-US');
  $('metrics').innerHTML = [['States and territories', m.statePairs, m.state], ['Counties in one state', m.countyPairs, m.county], ['Towns in one county', m.subPairs, m.sub]]
    .map(([a, p, v]) => `<tr><td>${a}</td><td>${n(p)}</td><td>${f(v[0])}</td><td>${f(v[2])}</td></tr>`).join('');
  $('drift').textContent = `The averages hold too. Across ${n(data.meta.counties.length)} counties, the worst gap between a county's target color and the true average of its ${n(data.nUnits)} towns is ${(m.countyErr * 100).toFixed(2)}. For states it is ${(m.stateErr * 100).toFixed(2)}.`;
  $('cvd').textContent = `the closest pair of neighboring states is still ${f(m.cvdMin)} apart in simulation`;
  $('cities').textContent = `Cities do not fit inside counties. In the Census Bureau's 2020 list, ${n(m.placesSplit)} of ${n(m.places)} incorporated places cross a county line, including New York, Chicago, Houston, Dallas, Atlanta and Kansas City.`;
  const order = data.meta.states.map((s, i) => [s[0], i]).sort((a, b) => a[0].localeCompare(b[0]));
  $('pick').append(...order.map(([t, i]) => new Option(t, i)));
  $('pick').value = order.find(([t]) => t === 'Illinois')[1];
  $('pick').onchange = bars;
}

// ---------------------------------------------------------------- start
try { if (!initGL()) gpu = null; } catch { gpu = null; }
if (!gpu) showFlat(true);
resize();
if (!lite) {
  const h = location.hash.slice(1).split(',').map(Number);
  if (h.length === 3 && h.every(Number.isFinite) && h[2] > 0) { [cam.x, cam.y, cam.k] = h; atHome = false; clampCam(); changed(); }
}
new ResizeObserver(resize).observe(stage);
addEventListener('orientationchange', () => setTimeout(resize, 250));

picture.onload = () => { if (gpu && !gpu.tex) uploadPicture(); changed(); };
let tries = 0;
picture.onerror = () => { if (tries++ < 4) setTimeout(() => { picture.src = 'img/overview.webp?retry=' + tries; }, 800 * 2 ** tries); };
picture.src = 'img/overview.webp';

const fail = (msg) => { status.hidden = false; status.textContent = `Close-up borders could not load (${msg}). This is the still picture instead.`; };
const worker = new Worker('worker.js');
worker.onerror = (e) => { waiting = -1; fail(e.message || 'worker error'); };
worker.onmessage = ({ data: d }) => {
  if (d.type === 'error') { waiting = -1; if (!data) fail(d.error); return; }
  if (d.type === 'state') { gotState(d.state, d.mesh); return; }
  data = d;
  indexUnits(); fillSheet();
  if (gpu) upload(data.coarse);
  status.hidden = true;
  changed();
  if (about.open) bars();
  document.documentElement.dataset.ready = '1';
};
worker.postMessage({ type: 'load' });

// read-only view of the internals, for checking memory and gestures from the console
window.mapState = () => ({ ...cam, dpr, lite, losses, gl: !!gpu, atHome, fingers: pts.size, fineStates: fine.size, fineMB: +(fineBytes / 1048576).toFixed(1), coarseMB: data ? +(bytes(data.coarse) / 1048576).toFixed(1) : 0, coarseTriangles: data ? data.coarse.idx.length / 3 : 0 });
