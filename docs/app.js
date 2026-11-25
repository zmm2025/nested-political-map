// The map is one mesh with one fixed color per town. Nothing here reads the zoom
// level when it picks a color: zooming only moves the camera.
const $ = (id) => document.getElementById(id);
const canvas = $('map'), poster = $('poster'), stage = $('stage'), status = $('status');

const PICTURE = [-2460, -1650, 2340, 1806];   // km, what the PNG covers
const LAND = [-2376, -1566, 2252, 1761];      // km, what the first view must show
const BG = [236, 237, 239];
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

const MAX_K = 64;                             // closer than this, the borders run out of detail
let W = 1, H = 1, dpr = 1;
const cam = { x: 0, y: 0, k: 1 };             // center in km, CSS px per km
let data = null, gl = null, gpu = null, queued = false, flight = 0;

// ---------------------------------------------------------------- camera
function fitScale() {
  const padY = W <= 640 ? 130 : 76, padX = W <= 640 ? 10 : 28;
  return Math.min((W - padX * 2) / (LAND[2] - LAND[0]), (H - padY * 2 + 48) / (LAND[3] - LAND[1]));
}
const home = () => { const k = fitScale(); return { x: (LAND[0] + LAND[2]) / 2, y: (LAND[1] + LAND[3]) / 2 - (W <= 640 ? 0 : 24 / k), k }; };
// distances at which each level is the thing you see
const LEVELS = { far: () => fitScale() * 0.16, state: fitScale, county: () => Math.max(0.95, fitScale() * 2.6), town: () => 6 };

function clampCam() {
  cam.k = Math.min(MAX_K, Math.max(fitScale() * 0.06, cam.k));
  cam.x = Math.min(LAND[2], Math.max(LAND[0], cam.x));
  cam.y = Math.min(LAND[3], Math.max(LAND[1], cam.y));
}
function zoomAt(px, py, f) {
  const wx = cam.x + (px - W / 2) / cam.k, wy = cam.y + (py - H / 2) / cam.k;
  const k0 = cam.k;
  cam.k *= f; clampCam();
  if (cam.k === k0) return;
  // zooming out past the first view drifts back to the middle of the country
  cam.x = wx - (px - W / 2) / cam.k; cam.y = wy - (py - H / 2) / cam.k;
  clampCam(); changed();
}
function flyTo(t) {
  cancelAnimationFrame(flight);
  const a = { ...cam };
  const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700;
  if (!ms) { Object.assign(cam, t); clampCam(); changed(); return; }
  const t0 = performance.now();
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms), e = u < 0.5 ? 4 * u * u * u : 1 - (2 - 2 * u) ** 3 / 2;
    cam.k = a.k * (t.k / a.k) ** e;
    // keep the on-screen path straight while the scale changes exponentially
    const s = Math.abs(t.k - a.k) < 1e-9 ? e : (1 / cam.k - 1 / a.k) / (1 / t.k - 1 / a.k);
    cam.x = a.x + (t.x - a.x) * s; cam.y = a.y + (t.y - a.y) * s;
    changed();
    if (u < 1) flight = requestAnimationFrame(step);
  };
  flight = requestAnimationFrame(step);
}
let hashTimer = 0, hashWanted = false;
function changed() {
  for (const b of document.querySelectorAll('[data-level]')) {
    const r = Math.abs(Math.log(cam.k / LEVELS[b.dataset.level]()));
    b.setAttribute('aria-pressed', r < 0.12 ? 'true' : 'false');
  }
  if (!queued) { queued = true; requestAnimationFrame(draw); }
  if (hashWanted) {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => history.replaceState(null, '', `#${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.k.toPrecision(3)}`), 300);
  }
}
function resize() {
  const wasHome = W === 1 || (Math.abs(cam.k / fitScale() - 1) < 0.02 && Math.abs(cam.x - home().x) < 30);
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height; dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  if (wasHome) Object.assign(cam, home());
  clampCam(); changed();
}

// ---------------------------------------------------------------- drawing
const VS = `#version 300 es
layout(location=0) in vec2 p; layout(location=1) in vec4 c;
uniform vec4 cam; flat out vec3 v;
vec3 dec(vec3 s){ return mix(pow((s+0.055)/1.055, vec3(2.4)), s/12.92, lessThanEqual(s, vec3(0.04045))); }
void main(){ gl_Position = vec4((p - cam.xy) * cam.zw, 0., 1.); v = dec(c.rgb); }`;
const FS = `#version 300 es
precision highp float; flat in vec3 v; out vec4 o; void main(){ o = vec4(v, 1.); }`;
const VS2 = `#version 300 es
uniform vec4 rect; uniform vec2 used; out vec2 uv;
void main(){ vec2 q = vec2(gl_VertexID & 1, gl_VertexID >> 1); uv = q * used; gl_Position = vec4(rect.xy + q * rect.zw, 0., 1.); }`;
const FS2 = `#version 300 es
precision highp float; uniform sampler2D t; uniform float lod; in vec2 uv; out vec4 o;
void main(){ vec3 l = textureLod(t, uv, lod).rgb;
  o = vec4(mix(1.055 * pow(l, vec3(1./2.4)) - 0.055, l * 12.92, lessThanEqual(l, vec3(0.0031308))), 1.); }`;

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'shader failed');
  return p;
}
function initGL() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL 2 is not available');
  const mesh = program(VS, FS), copy = program(VS2, FS2);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const attr = (i, arr, n, type, norm) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, type, norm, 0, 0);
  };
  attr(0, data.pos, 2, gl.FLOAT, false);
  attr(1, data.col, 4, gl.UNSIGNED_BYTE, true);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
  gpu = {
    mesh, copy, vao, empty: gl.createVertexArray(),
    cam: gl.getUniformLocation(mesh, 'cam'), rect: gl.getUniformLocation(copy, 'rect'),
    used: gl.getUniformLocation(copy, 'used'), lod: gl.getUniformLocation(copy, 'lod'),
    max: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096),
    samples: Math.min(4, gl.getParameter(gl.MAX_SAMPLES)), w: 0, h: 0,
  };
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.DITHER);
}
// multisampled sRGB target: averaging happens in linear light, like real optics
function target(w, h) {
  if (gpu.w === w && gpu.h === h) return;
  for (const k of ['rb', 'fb', 'tex', 'fb2']) if (gpu[k]) ({ rb: gl.deleteRenderbuffer, fb: gl.deleteFramebuffer, tex: gl.deleteTexture, fb2: gl.deleteFramebuffer })[k].call(gl, gpu[k]);
  gpu.w = w; gpu.h = h;
  gpu.rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, gpu.rb);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, gpu.samples, gl.SRGB8_ALPHA8, w, h);
  gpu.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, gpu.rb);
  gpu.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
  gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.SRGB8_ALPHA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gpu.fb2 = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fb2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gpu.tex, 0);
}

function placePoster() {
  const k = (PICTURE[2] - PICTURE[0]) * cam.k / 1600;
  poster.style.transform = `translate(${W / 2 + (PICTURE[0] - cam.x) * cam.k}px, ${H / 2 + (PICTURE[1] - cam.y) * cam.k}px) scale(${k})`;
}

// insets sit in open water, far from where they really are, so they get names
const labels = [['Guam and Northern Marianas', 350, 1705], ['American Samoa', 860, 1705], ['Puerto Rico and U.S. Virgin Islands', 1660, 1705]].map(([t, x, y]) => {
  const el = document.createElement('span');
  el.className = 'inset'; el.textContent = t; stage.insertBefore(el, document.querySelector('.title'));
  return { el, x, y };
});
function placeLabels() {
  const show = cam.k > 0.16 && cam.k < 4;
  for (const { el, x, y } of labels) {
    el.hidden = !show;
    if (show) el.style.transform = `translate(${W / 2 + (x - cam.x) * cam.k}px, ${H / 2 + (y - cam.y) * cam.k + 8}px) translateX(-50%)`;
  }
}

function draw() {
  queued = false;
  if (!poster.hidden) placePoster();
  placeLabels();
  if (!gpu) return;
  const cw = canvas.width, ch = canvas.height, k = cam.k * dpr;
  // device-pixel rectangle the map covers on screen
  const rx0 = Math.max(0, Math.floor(cw / 2 + (LAND[0] - 10 - cam.x) * k)), rx1 = Math.min(cw, Math.ceil(cw / 2 + (LAND[2] + 10 - cam.x) * k));
  const ry0 = Math.max(0, Math.floor(ch / 2 + (LAND[1] - 10 - cam.y) * k)), ry1 = Math.min(ch, Math.ceil(ch / 2 + (LAND[3] + 10 - cam.y) * k));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(BG[0] / 255, BG[1] / 255, BG[2] / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  // supersample while towns are only a few pixels wide
  let ss = 1;
  while (ss < 16 && k * ss < 1.4 && rw * ss * 2 <= gpu.max && rh * ss * 2 <= gpu.max && rw * rh * ss * ss * 4 <= 9e6) ss *= 2;
  const tw = rw * ss, th = rh * ss;
  // grow the buffer in coarse steps so zooming does not reallocate every frame
  const round = (v) => Math.max(v, Math.min(gpu.max, Math.ceil(v / 256) * 256));
  target(round(tw), round(th));
  gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fb);
  gl.viewport(0, 0, tw, th);
  gl.clearColor(lin(BG[0]), lin(BG[1]), lin(BG[2]), 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(gpu.mesh); gl.bindVertexArray(gpu.vao);
  const cx = cam.x + ((rx0 + rx1) / 2 - cw / 2) / k, cy = cam.y + ((ry0 + ry1) / 2 - ch / 2) / k;
  gl.uniform4f(gpu.cam, cx, cy, 2 * k / rw, -2 * k / rh);
  const hw = rw / 2 / k, hh = rh / 2 / k, b = data.cbox, s = data.cstart, n = s.length - 1;
  for (let c = 0, from = -1; c <= n; c++) {
    const seen = c < n && b[c * 4] < cx + hw && b[c * 4 + 2] > cx - hw && b[c * 4 + 1] < cy + hh && b[c * 4 + 3] > cy - hh;
    if (seen && from < 0) from = c;
    if (!seen && from >= 0) {
      gl.drawElements(gl.TRIANGLES, s[c] - s[from], gl.UNSIGNED_INT, s[from] * 4);
      from = -1;
    }
  }
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.fb2);
  gl.blitFramebuffer(0, 0, gpu.w, gpu.h, 0, 0, gpu.w, gpu.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cw, ch);
  gl.useProgram(gpu.copy); gl.bindVertexArray(gpu.empty);
  gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
  if (ss > 1) gl.generateMipmap(gl.TEXTURE_2D);
  gl.uniform4f(gpu.rect, rx0 / cw * 2 - 1, 1 - ry1 / ch * 2, rw / cw * 2, rh / ch * 2);
  gl.uniform2f(gpu.used, tw / gpu.w, th / gpu.h);
  gl.uniform1f(gpu.lod, Math.log2(ss));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------------------------------------------------------------- what is under the pointer
function indexUnits() {
  const { box, start, county, nUnits, meta } = data, nc = meta.counties.length;
  const cbox = new Float32Array(nc * 4).map((_, i) => (i % 4 < 2 ? 1e9 : -1e9)), cstart = new Uint32Array(nc + 1), cfirst = new Uint32Array(nc + 1);
  let prev = -1;
  for (let u = 0; u < nUnits; u++) {
    const c = county[u], o = c * 4;
    if (c !== prev) { cstart[c] = start[u]; cfirst[c] = u; prev = c; }
    cbox[o] = Math.min(cbox[o], box[u * 4]); cbox[o + 1] = Math.min(cbox[o + 1], box[u * 4 + 1]);
    cbox[o + 2] = Math.max(cbox[o + 2], box[u * 4 + 2]); cbox[o + 3] = Math.max(cbox[o + 3], box[u * 4 + 3]);
  }
  cstart[nc] = start[nUnits]; cfirst[nc] = nUnits;
  Object.assign(data, { cbox, cstart, cfirst });
}
function unitAt(x, y) {
  const { cbox, cfirst, box, start, idx, pos } = data;
  for (let c = 0; c < cfirst.length - 1; c++) {
    const o = c * 4;
    if (x < cbox[o] || x > cbox[o + 2] || y < cbox[o + 1] || y > cbox[o + 3]) continue;
    for (let u = cfirst[c]; u < cfirst[c + 1]; u++) {
      const q = u * 4;
      if (x < box[q] || x > box[q + 2] || y < box[q + 1] || y > box[q + 3]) continue;
      for (let i = start[u]; i < start[u + 1]; i += 3) {
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
  const u = unitAt(cam.x + (px - W / 2) / cam.k, cam.y + (py - H / 2) / cam.k);
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
const pts = new Map();
let moved = 0, pinch = 0, hover = 0;
const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
canvas.addEventListener('pointerdown', (e) => {
  cancelAnimationFrame(flight);
  canvas.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, local(e)); moved = pts.size > 1 ? 99 : 0; pinch = 0;
  canvas.classList.add('drag');
});
canvas.addEventListener('pointermove', (e) => {
  const p = local(e), was = pts.get(e.pointerId);
  if (!was) {
    if (e.pointerType !== 'touch') { cancelAnimationFrame(hover); hover = requestAnimationFrame(() => identify(...p)); }
    return;
  }
  pts.set(e.pointerId, p);
  if (pts.size === 1) {
    moved += Math.hypot(p[0] - was[0], p[1] - was[1]);
    if (moved < 4) return;
    cam.x -= (p[0] - was[0]) / cam.k; cam.y -= (p[1] - was[1]) / cam.k;
    clampCam(); changed();
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pinch) {
      cam.x -= (m[0] - pinch.m[0]) / cam.k; cam.y -= (m[1] - pinch.m[1]) / cam.k;
      zoomAt(m[0], m[1], d / pinch.d); changed();
    }
    pinch = { d, m };
  }
});
for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => {
  if (t === 'pointerup' && moved < 8 && pts.size === 1) identify(...local(e));
  pts.delete(e.pointerId); pinch = 0;
  if (!pts.size) canvas.classList.remove('drag'); else moved = 99;
});
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') { cancelAnimationFrame(hover); $('readout').hidden = true; } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); cancelAnimationFrame(flight);
  const d = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 400 : 1);
  zoomAt(...local(e), Math.exp(-Math.max(-240, Math.min(240, d)) * (e.ctrlKey ? 0.01 : 0.0022)));
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  const [px, py] = local(e), k = Math.min(MAX_K, cam.k * 3);
  const wx = cam.x + (px - W / 2) / cam.k, wy = cam.y + (py - H / 2) / cam.k;
  flyTo({ x: wx - (px - W / 2) / k, y: wy - (py - H / 2) / k, k });
});
canvas.addEventListener('keydown', (e) => {
  const step = 90 / cam.k;
  const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (pan) { cam.x += pan[0]; cam.y += pan[1]; clampCam(); changed(); identify(W / 2, H / 2); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') { zoomAt(W / 2, H / 2, 1.4); identify(W / 2, H / 2); }
  else if (e.key === '-' || e.key === '_') { zoomAt(W / 2, H / 2, 1 / 1.4); identify(W / 2, H / 2); }
  else if (e.key === '0' || e.key === 'Home') flyTo(home());
});
$('zin').onclick = () => flyTo({ ...cam, k: Math.min(MAX_K, cam.k * 1.8) });
$('zout').onclick = () => flyTo({ ...cam, k: Math.max(fitScale() * 0.06, cam.k / 1.8) });
for (const b of document.querySelectorAll('[data-level]')) b.onclick = () => {
  const l = b.dataset.level, k = LEVELS[l]();
  if (l === 'far' || l === 'state') return flyTo({ ...home(), k });
  // from the whole country, dive toward a spot where three states meet
  const wide = cam.k < fitScale() * 1.3;
  flyTo({ x: wide ? 560 : cam.x, y: wide ? -40 : cam.y, k });
};

// ---------------------------------------------------------------- the sheet
const about = $('about');
$('openAbout').onclick = () => { about.showModal(); if (data) { $('pick').value = lastState >= 0 ? lastState : $('pick').value; bars(); } };
$('closeAbout').onclick = () => about.close();
about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

function bars() {
  const { meta, area, county, cfirst } = data, s = +$('pick').value;
  const cs = meta.countyState.flatMap((v, c) => (v === s ? [c] : []));
  const rows = [[], [], []];
  for (const c of cs) {
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
resize();
const h = location.hash.slice(1).split(',').map(Number);
if (h.length === 3 && h.every(Number.isFinite) && h[2] > 0) { [cam.x, cam.y, cam.k] = h; clampCam(); changed(); }
new ResizeObserver(resize).observe(stage);

const worker = new Worker('worker.js');
const fail = (msg) => { status.hidden = false; status.textContent = `The close-up view could not load (${msg}). This is the still picture instead.`; };
worker.onerror = (e) => fail(e.message || 'worker error');
worker.onmessage = ({ data: d }) => {
  worker.terminate();
  if (d.error) return fail(d.error);
  data = d;
  try {
    indexUnits(); fillSheet(); initGL();
  } catch (e) { gpu = null; return fail(e.message); }
  draw();
  canvas.classList.add('ready');
  poster.hidden = true; status.hidden = true; hashWanted = true;
  document.documentElement.dataset.ready = '1';
  if (about.open) bars();
};
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gpu = null; });
canvas.addEventListener('webglcontextrestored', () => { initGL(); changed(); });
worker.postMessage(0);
