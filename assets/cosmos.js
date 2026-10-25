/* ==================================================================
   COSMOS — the 3D world (Three.js)
   One camera flies down a path through space. Every stop in the story
   has an anchor on that path; scroll position decides where the
   camera is. Layers move at different speeds by depth and by their
   own drift so the whole thing feels deep.
   ================================================================== */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

THREE.ColorManagement.enabled = false;

const D = 34;        // distance between stops
const HOLD = 9;      // camera distance in front of a stop while dwelling
const LANE_GAP = 5.5; // spacing between photos in a "time flies" corridor
const MEM_BACK = 4;   // the stats photo ring sits this far behind the stop, so it reads as a backdrop
const LANE_IN_D = 2.4, LANE_IN_M = 2.15; // clear space around the flight line (desktop sideways / phone up-down)
// a corridor photo fades in between these distances, so the ones far behind never stack up
const LANE_FAR_D = 30, LANE_FULL_D = 20, LANE_FAR_M = 20, LANE_FULL_M = 13;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const col = (h) => new THREE.Color(h);

/* ---------------- shared point-sprite shader ---------------- */
const NOISE = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
`;

function pointsVS(decl, transform) {
  return `
  uniform float uTime; uniform float uPR; uniform float uSize; uniform float uFade;
  uniform float uCamZ; uniform float uWrap; uniform float uMaxPx; uniform vec2 uTilt; uniform float uSway;
  attribute float aScale; attribute float aPhase; attribute vec3 aColor; attribute float aX;
  varying vec3 vColor; varying float vAlpha;
  ${decl}
  void main(){
    vec3 p = position;
    float boost = 1.0;
    ${transform}
    if(uWrap > 0.0){ p.z = uCamZ - mod(uCamZ - p.z, uWrap); }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    float tw = 0.62 + 0.38 * sin(uTime * (0.5 + aPhase * 2.4) + aPhase * 40.0);
    gl_PointSize = min(uSize * aScale * uPR * tw * sqrt(boost) * (40.0 / max(dist, 0.4)), uMaxPx * uPR);
    vAlpha = uFade * min(boost, 3.0) * smoothstep(300.0, 70.0, dist) * smoothstep(0.25, 2.2, dist);
    if(uWrap > 0.0){ vAlpha *= smoothstep(uWrap, uWrap * 0.6, dist); }
    vColor = aColor;
    gl_Position = projectionMatrix * mv;
    gl_Position.xy += uTilt * uSway * gl_Position.w;
  }`;
}
const POINTS_FS = `
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vec2 c = gl_PointCoord - 0.5; float d = length(c);
    float glow = exp(-d * d * 26.0);
    float core = smoothstep(0.09, 0.0, d);
    float a = (glow * 0.75 + core) * vAlpha;
    if(a < 0.003) discard;
    gl_FragColor = vec4(vColor * (glow + core * 1.4), a);
  }`;

function pointsMaterial(shared, { size = 4, decl = "", transform = "", uniforms = {}, wrap = 0, maxPx = 48, sway = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime, uPR: shared.uPR, uCamZ: shared.uCamZ, uTilt: shared.uTilt, uSway: { value: sway },
      uSize: { value: size }, uFade: { value: 1 }, uWrap: { value: wrap }, uMaxPx: { value: maxPx },
      ...uniforms
    },
    vertexShader: pointsVS(decl, transform),
    fragmentShader: POINTS_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
}

function pointsGeometry(n, fill) {
  const pos = new Float32Array(n * 3), colr = new Float32Array(n * 3);
  const sc = new Float32Array(n), ph = new Float32Array(n), x = new Float32Array(n);
  const extra = {};
  for (let i = 0; i < n; i++) {
    const o = fill(i, extra);
    pos.set(o.p, i * 3); colr.set([o.c.r, o.c.g, o.c.b], i * 3);
    sc[i] = o.s ?? 1; ph[i] = o.ph ?? Math.random(); x[i] = o.x ?? 0;
    if (o.v3) { for (const k in o.v3) { (extra[k] ||= new Float32Array(n * 3)).set(o.v3[k], i * 3); } }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aColor", new THREE.BufferAttribute(colr, 3));
  g.setAttribute("aScale", new THREE.BufferAttribute(sc, 1));
  g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
  g.setAttribute("aX", new THREE.BufferAttribute(x, 1));
  for (const k in extra) g.setAttribute(k, new THREE.BufferAttribute(extra[k], 3));
  return g;
}

const STAR_COLS = [
  [col("#fff4e6"), 0.58], [col("#f2c27b"), 0.16], [col("#ff8fb1"), 0.14], [col("#a9b4ff"), 0.12]
];
function starColor() {
  let r = Math.random();
  for (const [c, w] of STAR_COLS) { if ((r -= w) <= 0) return c; }
  return STAR_COLS[0][0];
}

/* ---------------- photo shader ---------------- */
const PHOTO_VS = `
  uniform float uVel; uniform float uTime; uniform float uPhase;
  varying vec2 vUv; varying float vDepth;
  void main(){
    vUv = uv;
    vec3 p = position;
    p.z -= sin(uv.x * 3.14159) * uVel * 0.32 + sin(uv.y * 3.14159) * uVel * 0.12;
    p.z += sin(uv.x * 5.0 + uTime * 1.1 + uPhase) * 0.012;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const PHOTO_FS = `
  uniform sampler2D uTex; uniform vec2 uCover; uniform float uAspect;
  uniform float uOpacity; uniform float uReveal; uniform float uVel; uniform float uFocus; uniform float uRadius;
  uniform vec3 uRim;
  varying vec2 vUv; varying float vDepth;
  ${NOISE}
  float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main(){
    vec2 uv = (vUv - 0.5) * uCover + 0.5;
    float sh = uVel * 0.012;
    vec3 c;
    c.r = texture2D(uTex, uv + vec2(sh, 0.0)).r;
    c.g = texture2D(uTex, uv).g;
    c.b = texture2D(uTex, uv - vec2(sh, 0.0)).b;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l) * vec3(0.82, 0.8, 1.0), c, 0.3 + 0.7 * uFocus);
    c *= 0.5 + 0.5 * uFocus;
    vec2 cc = vUv - 0.5; c *= 1.0 - dot(cc, cc) * 0.55;
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = sdRound(p, vec2(uAspect * 0.5, 0.5), uRadius);
    float mask = 1.0 - smoothstep(-0.006, 0.002, d);
    float rim = smoothstep(0.022, 0.0, abs(d + 0.006));
    c += uRim * rim * (0.25 + 0.5 * uFocus);
    float n = noise(vUv * 6.0) * 0.65 + noise(vUv * 21.0) * 0.35;
    float edge = uReveal * 1.25 - 0.12;
    float hidden = smoothstep(edge - 0.05, edge, n);
    float burn = smoothstep(edge - 0.13, edge - 0.02, n) * (1.0 - hidden);
    c += uRim * burn * 2.4;
    float a = mask * (1.0 - hidden) * uOpacity * smoothstep(0.5, 2.6, vDepth);
    if(a < 0.002) discard;
    gl_FragColor = vec4(c, a);
  }`;

const NEBULA_FS = `
  uniform float uTime; uniform vec2 uRes; uniform vec3 uBase; uniform vec3 uC1; uniform vec3 uC2;
  uniform vec2 uOffset; uniform vec2 uTO; uniform float uDrift; uniform float uPulse; uniform float uBright;
  ${NOISE}
  float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
  void main(){
    vec2 pv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y + uOffset;
    vec2 p = pv + uTO; // uTO: device tilt only moves the clouds, not the vignette
    float t = uTime * 0.018;
    vec2 q = vec2(fbm(p * 1.3 + vec2(t, uDrift)), fbm(p * 1.3 - vec2(t, -uDrift) + 3.1));
    float n = fbm(p * 1.7 + q * 1.7 + vec2(uDrift * 0.6, 0.0));
    float n2 = fbm(p * 3.1 + q * 2.2 - t);
    vec3 c = uBase;
    c = mix(c, uC1, smoothstep(0.38, 0.95, n) * 0.62 * uBright);
    c = mix(c, uC2, smoothstep(0.58, 1.05, n2) * 0.30 * uBright);
    c += uC2 * pow(smoothstep(0.62, 0.95, n), 3.0) * 0.18 * uBright;
    float v = smoothstep(1.35, 0.15, length(pv * vec2(0.75, 1.0)));
    c *= 0.5 + 0.5 * v;
    c += uC2 * uPulse * 0.12;
    c += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.022;
    gl_FragColor = vec4(c, 1.0);
  }`;

/* ---------------- placeholder card (canvas) ---------------- */
function placeholderTexture(label, idx, total) {
  const w = 720, h = 960, cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  const bg = g.createRadialGradient(w * 0.5, h * 0.42, 40, w * 0.5, h * 0.5, h * 0.75);
  bg.addColorStop(0, "#2a1d4a"); bg.addColorStop(1, "#0b0818");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // stars + a tiny constellation
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(255,${200 + Math.random() * 55 | 0},${190 + Math.random() * 60 | 0},${Math.random() * 0.7})`;
    const r = Math.random() * 1.8; g.beginPath(); g.arc(Math.random() * w, Math.random() * h, r, 0, TAU); g.fill();
  }
  const pts = Array.from({ length: 6 }, (_, i) => [w * (0.25 + 0.5 * Math.random()), h * (0.22 + i * 0.05 + Math.random() * 0.06)]);
  g.strokeStyle = "rgba(242,194,123,.45)"; g.lineWidth = 1.5; g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  pts.forEach(([x, y]) => { g.fillStyle = "#ffe2a8"; g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill(); });
  // dashed frame
  g.setLineDash([14, 12]); g.strokeStyle = "rgba(242,194,123,.6)"; g.lineWidth = 3;
  g.strokeRect(34, 34, w - 68, h - 68); g.setLineDash([]);
  g.textAlign = "center"; g.fillStyle = "#f7efe4";
  g.font = "italic 300 66px 'Cormorant Garamond', Georgia, serif";
  g.fillText("a memory", w / 2, h * 0.62);
  g.fillText("on its way", w / 2, h * 0.62 + 70);
  g.fillStyle = "rgba(242,194,123,.9)";
  g.font = "500 24px 'JetBrains Mono', ui-monospace, monospace";
  g.fillText(label.toUpperCase(), w / 2, h * 0.82);
  g.fillStyle = "rgba(247,239,228,.5)";
  g.fillText(String(idx + 1).padStart(2, "0") + " / " + String(total).padStart(2, "0"), w / 2, h * 0.82 + 40);
  const t = new THREE.CanvasTexture(cv);
  t.userData = { w, h };
  return t;
}

/* ---------------- collage: up to 3 photos in a box, never overlapping ----------------
   a = aspect ratios (w/h), first is the hero. Tries "hero + column on the right" and
   "hero + row underneath" and keeps whichever covers more of the box. */
function collage(a, W, H, g) {
  const n = a.length;
  const fit = (r, w, h) => { const k = Math.min(w / (r.w || 1e-6), h / (r.h || 1e-6), 1); return k; };
  if (n === 0) return [];
  if (n === 1) { const h = Math.min(H, W / a[0]), w = h * a[0]; return [{ x: (W - w) / 2, y: (H - h) / 2, w, h }]; }
  const rest = a.slice(1), m = rest.length;
  const S = rest.reduce((t, x) => t + 1 / x, 0), T = rest.reduce((t, x) => t + x, 0);
  // A: hero left, column right
  const hA = Math.max(0.1, Math.min(H, (W - g + ((m - 1) * g) / S) / (a[0] + 1 / S)));
  const wc = Math.max(0.1, (hA - (m - 1) * g) / S);
  const A = [{ x: 0, y: 0, w: hA * a[0], h: hA }]; let y = 0;
  rest.forEach((r) => { A.push({ x: hA * a[0] + g, y, w: wc, h: wc / r }); y += wc / r + g; });
  // B: hero top, row below
  const wB = Math.max(0.1, Math.min(W, (H - g + ((m - 1) * g) / T) / (1 / a[0] + 1 / T)));
  const hr = Math.max(0.1, (wB - (m - 1) * g) / T);
  const B = [{ x: 0, y: 0, w: wB, h: wB / a[0] }]; let x = 0;
  rest.forEach((r) => { B.push({ x, y: wB / a[0] + g, w: hr * r, h: hr }); x += hr * r + g; });
  const area = (L) => L.reduce((t, r) => t + r.w * r.h, 0);
  const box = (L) => ({ w: Math.max(...L.map((r) => r.x + r.w)), h: Math.max(...L.map((r) => r.y + r.h)) });
  let L = area(A) >= area(B) ? A : B;
  // safety: scale down if rounding pushed it outside the box, then centre it
  const bx = box(L), k = Math.min(1, W / bx.w, H / bx.h);
  L = L.map((r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
  const b2 = box(L), ox = (W - b2.w) / 2, oy = (H - b2.h) / 2;
  return L.map((r) => ({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h }));
}

/* ---------------- photo card ---------------- */
class Card {
  constructor(shared, tex, rim) {
    this.u = {
      uTex: { value: tex }, uCover: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 0.75 },
      uOpacity: { value: 0 }, uReveal: { value: 0 }, uVel: { value: 0 }, uFocus: { value: 1 },
      uRadius: { value: 0.03 }, uRim: { value: col(rim || "#f2c27b") },
      uTime: shared.uTime, uPhase: { value: Math.random() * 10 }
    };
    this.mesh = new THREE.Mesh(shared.planeGeo, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: PHOTO_VS, fragmentShader: PHOTO_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    this.mesh.renderOrder = 2;
    this.phase = Math.random() * TAU;
    this.ready = true; this.loading = false;
    this.setTexture(tex);
  }
  setTexture(tex) {
    this.u.uTex.value = tex;
    const im = tex.image, iw = (im && (im.naturalWidth || im.width)) || tex.userData.w || 3, ih = (im && (im.naturalHeight || im.height)) || tex.userData.h || 4;
    this.imgAspect = iw / ih;
  }
  setRect(w, h) {
    this.mesh.scale.set(w, h, 1);
    this.u.uAspect.value = w / h;
    const ra = w / h, ia = this.imgAspect || ra;
    if (ra > ia) this.u.uCover.value.set(1, ia / ra); else this.u.uCover.value.set(ra / ia, 1);
    this.w = w; this.h = h;
  }
  size(h, maxW) {
    let w = h * this.imgAspect;
    if (maxW && w > maxW) { w = maxW; h = w / this.imgAspect; }
    this.mesh.scale.set(w, h, 1);
    this.u.uAspect.value = w / h;
    this.u.uCover.value.set(1, 1);
    this.h = h; this.w = w;
  }
}

/* ================================================================== */
export class Cosmos {
  constructor(canvas, stops, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.stops = stops.filter((s) => s.type !== "marquee");
    this.media = opts.media || {};
    // z position of every stop along the flight path. A corridor (lane-a -> lane-b) is a long
    // straight run with one photo every LANE_GAP; the hops into and out of it are shorter.
    this.A = [0];
    for (let k = 1; k < this.stops.length; k++) {
      const p = this.stops[k - 1], q = this.stops[k];
      const gap = p.type === "lane-a" ? (p.lane.media.length + 1) * LANE_GAP
        : (p.type === "lane-b" || q.type === "lane-a") ? D * 0.62 : D;
      this.A.push(this.A[k - 1] - gap);
    }
    this.mobile = false;
    this.s = -0.9; this.sTarget = 0; this.vel = 0; this.intro = -0.9;
    this.ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    this.level = 0; this.time = 0;
    this.shooting = []; this.fireworks = []; this.nextShoot = 3;

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }));
    r.setClearColor(0x06050f, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.scene.add(this.camera);

    this.shared = {
      uTime: { value: 0 }, uPR: { value: 1 }, uCamZ: { value: 0 }, uTilt: { value: new THREE.Vector2() },
      planeGeo: new THREE.PlaneGeometry(1, 1, 24, 24)
    };
    this.cards = [];
    this.anchorZ = (k) => this.A[clamp(k, 0, this.A.length - 1)];

    this.measureMode();
    this.buildNebula();
    this.buildStars();
    this.buildGalaxy();
    this.buildRing();
    this.buildDayOne();
    this.buildHeart();
    this.buildShooting();
    this.buildFireworks();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      this.ptr.tx = (e.clientX / innerWidth) * 2 - 1;
      this.ptr.ty = (e.clientY / innerHeight) * 2 - 1;
      if (e.pointerType === "mouse") this.hoverAt = [e.clientX, e.clientY];
    }, { passive: true });
    // tap / click a flying photo to open it full screen
    this.ray = new THREE.Raycaster(); this.ndc = new THREE.Vector2();
    let down = null;
    window.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY, performance.now()]; }, { passive: true });
    window.addEventListener("pointerup", (e) => {
      if (!down || !this.onPick) return;
      const [x, y, t] = down; down = null;
      if (Math.hypot(e.clientX - x, e.clientY - y) > 10 || performance.now() - t > 700) return;
      if (e.target && e.target.closest && e.target.closest("button, a, input, video, .vw, .gate, .cb, .hud-pill, .q-btns")) return;
      const hit = this.hitAt(e.clientX, e.clientY);
      if (hit) this.onPick(hit);
    });
  }

  hitAt(x, y) {
    this.ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const objs = this.cards.filter((c) => c.mesh.visible && c.ready && c.u.uOpacity.value > 0.35 && c.mesh.userData.pick).map((c) => c.mesh);
    const hit = this.ray.intersectObjects(objs, false)[0];
    return hit ? hit.object.userData.pick : null;
  }

  measureMode() {
    const a = innerWidth / innerHeight;
    this.aspect = a;
    this.mobile = a < 0.85 || innerWidth <= 760; // same rule as the CSS/app phone layout
    this.xScale = this.mobile ? 1 : clamp(a / 1.6, 0.62, 1);
  }

  /* ---------- device tilt (phones & tablets) ----------
     The sky swings with the device while the photos barely move: a window into space.
     Whatever angle the device is held at counts as "centre", and it slowly re-centres. */
  enableMotion() {
    if (this.motionOn) return;
    this.motionOn = true;
    this.tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    this.orientRaw = null; this.orientBase = null;
    addEventListener("deviceorientation", (e) => {
      if (e.beta == null || e.gamma == null) return;
      const ang = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) % 360;
      const b = e.beta, g = e.gamma;
      // map the device axes onto the screen's axes for portrait / landscape / upside down
      let x = g, y = b;
      if (ang === 90) { x = b; y = -g; } else if (ang === 180) { x = -g; y = -b; } else if (ang === 270 || ang === -90) { x = -b; y = g; }
      this.orientRaw = { x, y };
      if (!this.orientBase || Math.abs(x - this.orientBase.x) > 60 || Math.abs(y - this.orientBase.y) > 60) this.orientBase = { x, y };
    }, { passive: true });
  }
  updateTilt(dt) {
    if (!this.motionOn) return;
    const T = this.tilt, r = this.orientRaw, b = this.orientBase;
    if (r && b) {
      // slowly drift the centre towards how it's being held now (re-centres in ~6 s)
      const k = 1 - Math.exp(-dt / 9);
      b.x += (r.x - b.x) * k; b.y += (r.y - b.y) * k;
      const soft = (d) => Math.tanh(d / 12); // about ±12° of tilt already gives most of the swing
      T.tx = soft(r.x - b.x); T.ty = soft(r.y - b.y);
    }
    const f = 1 - Math.exp(-dt * 7);
    T.x += (T.tx - T.x) * f; T.y += (T.ty - T.y) * f;
    // the sky stays put in the room while the device turns (like looking through a window)
    this.shared.uTilt.value.set(T.x, -T.y);
  }

  /* ---------- loading ---------- */
  /* ---------- loading: photos stream in as you approach each chapter ---------- */
  loadTex(url) {
    return new Promise((res) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => {
        let src = img;
        const max = this.mobile ? 1024 : 1600, big = Math.max(img.naturalWidth, img.naturalHeight);
        if (big > max) {
          const k = max / big, c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          src = c;
        }
        const t = new THREE.Texture(src);
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.anisotropy = Math.min(this.mobile ? 4 : 8, this.renderer.capabilities.getMaxAnisotropy());
        t.userData = { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
        t.needsUpdate = true;
        res(t);
      });
      img.onerror = () => res(null);
      // the local (double-click) build packs photos into data files, since browsers won't let
      // WebGL read loose image files from disk; online this is just the normal url
      (window.localSrc ? window.localSrc(url) : Promise.resolve(url)).then((u) => { img.src = u; });
    });
  }
  ensureCard(c, url, after) {
    if (c.ready || c.loading || !url) return null;
    c.loading = true; c.want = true;
    return this.loadTex(url).then((t) => {
      if (!t) t = placeholderTexture("photo missing", 0, 1);
      if (!c.want) { c.loading = false; t.dispose(); return; }
      (this.upQ || (this.upQ = [])).push(() => {
        c.loading = false;
        if (!c.want) { t.dispose(); return false; }
        try { this.renderer.initTexture && this.renderer.initTexture(t); } catch (e) {}
        c.setTexture(t); c.ready = true;
        after && after();
        return true;
      });
    });
  }
  /* warm the browser cache a few scenes ahead, so photos are already downloaded when we arrive */
  prefetch(url) {
    const seen = this.pf || (this.pf = new Set());
    if (!url || seen.has(url) || window.localSrc) return;
    seen.add(url);
    (this.pfQ || (this.pfQ = [])).push(url);
    this.pump();
  }
  pump() {
    this.pfN = this.pfN || 0;
    while (this.pfN < 3 && this.pfQ && this.pfQ.length) {
      const url = this.pfQ.shift(); this.pfN++;
      const done = () => { this.pfN--; this.pump(); };
      try { fetch(url, { priority: "low" }).then((r) => r.blob()).then(done, done); } catch (e) { done(); }
    }
  }
  dropCard(c) {
    c.want = false;
    if (!c.ready || !c.file) return;
    const t = c.u.uTex.value; c.u.uTex.value = this.blank; c.ready = false;
    t && t.dispose && t.dispose();
  }
  stream(s) {
    const near = this.mobile ? 2.6 : 3.6, far = this.mobile ? 4.5 : 6.5, ahead = 9;
    (this.chapters || []).forEach((ch) => {
      const d = ch.k - s;
      ch.cards.forEach((c, i) => {
        if (!c.file) return;
        if (d > 0 && d < ahead) this.prefetch("assets/photos/" + c.file);
        if (d > -1.6 && d < near) this.ensureCard(c, "assets/photos/" + c.file, () => this.layoutChapter(ch));
        else if (d < -3 || d > far) this.dropCard(c);
      });
    });
    const camZ = this.camAt(s);
    (this.lanes || []).forEach((ln) => ln.cards.forEach((c) => {
      const d = camZ - c.base.z;
      if (d > 0 && d < 260) this.prefetch("assets/md/" + c.file + ".jpg");
      if (d > -4 && d < (this.laneFar || 30) + 26) this.ensureCard(c, "assets/md/" + c.file + ".jpg", () => this.layoutLane(ln));
      else if (d < -10 || d > (this.laneFar || 30) + 60) this.dropCard(c);
    }));
    if (this.memories) {
      const d = this.memories.k - s;
      this.memories.cards.forEach((c) => {
        if (d > -1.6 && d < near) this.ensureCard(c, "assets/thumbs/" + c.file, () => c.size(this.mobile ? 1.25 : 1.7, 2.6));
        else if (d < -3 || d > far) this.dropCard(c);
      });
    }
  }
  async load(onProgress) {
    const files = [];
    this.stops.forEach((s) => (s.photos || []).forEach((f) => f && !files.includes(f) && files.push(f)));
    this.photoFiles = files;
    try { await document.fonts.ready; } catch (e) {}
    const bc = document.createElement("canvas"); bc.width = bc.height = 4;
    const bg = bc.getContext("2d"); bg.fillStyle = "#120c26"; bg.fillRect(0, 0, 4, 4);
    this.blank = new THREE.CanvasTexture(bc); this.blank.userData = { w: 3, h: 4 };
    this.buildChapters();
    this.buildLanes();
    this.buildMemories();
    this.layout();
    // the first two chapters load before the gate opens; everything else streams in later
    const first = this.chapters.slice(0, 2).flatMap((ch) => ch.cards.map((c, i) => [ch, c, i])).filter(([, c]) => c.file);
    let done = 0;
    await Promise.all(first.map(([ch, c, i]) => Promise.resolve(this.ensureCard(c, "assets/photos/" + c.file, () => this.layoutChapter(ch)))
      .then(() => { done++; onProgress && onProgress(done / first.length); })));
    try { this.renderer.compile(this.scene, this.camera); } catch (e) {}
  }

  /* ---------- background nebula ---------- */
  buildNebula() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.neb = {
      uTime: this.shared.uTime, uRes: { value: new THREE.Vector2(1, 1) },
      uBase: { value: col("#06050f") }, uC1: { value: col("#3a1d5c") }, uC2: { value: col("#ff8fb1") },
      uOffset: { value: new THREE.Vector2() }, uTO: { value: new THREE.Vector2() }, uDrift: { value: 0 }, uPulse: { value: 0 }, uBright: { value: 1 }
    };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.neb,
      vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.9999, 1.0); }",
      fragmentShader: matchMedia("(max-width: 760px)").matches ? NEBULA_FS.replace("i < 5", "i < 3") : NEBULA_FS, depthTest: false, depthWrite: false
    }));
    m.frustumCulled = false; m.renderOrder = -10;
    this.scene.add(m);
    this.palettes = this.stops.map((s) => (s.palette || ["#2a1a4a", "#f2c27b"]).map(col));
  }

  /* ---------- star layers (each moves at its own speed by depth) ---------- */
  buildStars() {
    const mob = matchMedia("(max-width: 760px)").matches;
    const zFar = this.A[this.A.length - 1] - 60, zNear = 40;
    // the story is long now: add stars in proportion to the path so the sky doesn't thin out
    const k = Math.min(2.2, Math.max(1, -this.A[this.A.length - 1] / (28 * D)));
    const layer = (n, rMin, rMax, size, wrap = 0, maxPx = 48, sway = 0) => {
      const g = pointsGeometry(n, () => {
        const a = Math.random() * TAU, rr = rMin + Math.pow(Math.random(), 0.8) * (rMax - rMin);
        const z = wrap ? -Math.random() * wrap : rand(zFar, zNear);
        return { p: [Math.cos(a) * rr, Math.sin(a) * rr * 0.8, z], c: starColor(), s: rand(0.35, 1.5) };
      });
      const m = pointsMaterial(this.shared, { size, wrap, maxPx, sway });
      const pts = new THREE.Points(g, m); pts.frustumCulled = false; this.scene.add(pts);
      return pts;
    };
    // sway: how far each layer swings when the phone/tablet is tilted (far stars most, dust least)
    this.farStars = layer(Math.round((mob ? 2400 : 5200) * k), 28, 130, 10, 0, 48, 0.42);
    this.midStars = layer(Math.round((mob ? 1200 : 2600) * k), 6, 30, 4.2, 0, 48, 0.26);
    this.dust = layer(mob ? 260 : 520, 0.8, 9, 0.85, 42, 22, 0.14);
    this.dust.renderOrder = 4;

    // speed lines: stretch along z with scroll velocity
    const n = mob ? 110 : 220, pos = new Float32Array(n * 6), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, rr = rand(1.8, 14), z = -Math.random() * 52;
      pos.set([Math.cos(a) * rr, Math.sin(a) * rr * 0.8, z, Math.cos(a) * rr, Math.sin(a) * rr * 0.8, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    this.lineU = { uCamZ: this.shared.uCamZ, uStretch: { value: 0 }, uAlpha: { value: 0 }, uTilt: this.shared.uTilt };
    const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: this.lineU,
      vertexShader: `uniform float uCamZ; uniform float uStretch; uniform vec2 uTilt; attribute float aEnd; varying float vA;
        void main(){ vec3 p = position; p.z = uCamZ - mod(uCamZ - p.z, 52.0); p.z += aEnd * uStretch;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vA = (1.0 - aEnd * 0.9) * smoothstep(52.0, 20.0, -mv.z) * smoothstep(0.5, 4.0, -mv.z);
          gl_Position = projectionMatrix * mv; gl_Position.xy += uTilt * 0.14 * gl_Position.w; }`,
      fragmentShader: `uniform float uAlpha; varying float vA; void main(){ gl_FragColor = vec4(1.0, 0.9, 0.8, vA * uAlpha); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    lines.frustumCulled = false; lines.renderOrder = 4;
    this.scene.add(lines);
  }

  /* ---------- hero: a spiral galaxy with two stars at its heart ---------- */
  buildGalaxy() {
    const mob = matchMedia("(max-width: 760px)").matches;
    const N = mob ? 7000 : 15000, R = 9;
    const cIn = col("#fff1d6"), cMid = col("#ff9fbf"), cOut = col("#7f6bff");
    const g = pointsGeometry(N, (i) => {
      const r = Math.pow(Math.random(), 1.5) * R + 0.15;
      const branch = ((i % 4) / 4) * TAU, spin = r * 0.75;
      const sp = (k) => Math.pow(Math.random(), 2.6) * (Math.random() < 0.5 ? 1 : -1) * k * (0.25 + r * 0.12);
      const t = r / R;
      const c = t < 0.4 ? cIn.clone().lerp(cMid, t / 0.4) : cMid.clone().lerp(cOut, (t - 0.4) / 0.6);
      return { p: [Math.cos(branch + spin) * r + sp(1.2), sp(0.5), Math.sin(branch + spin) * r + sp(1.2)], c, s: rand(0.3, 1.1) * (1.2 - t * 0.5) };
    });
    this.galaxyU = { uRot: { value: 0 } };
    const m = pointsMaterial(this.shared, {
      size: 2.6, maxPx: 18, uniforms: this.galaxyU, sway: 0.24,
      decl: "uniform float uRot;",
      transform: `float rr = length(p.xz); float ang = uRot * (2.2 / (rr + 0.7)) + uRot * 0.12;
        float cs = cos(ang), sn = sin(ang); p.xz = mat2(cs, -sn, sn, cs) * p.xz;`
    });
    this.galaxy = new THREE.Group();
    const pts = new THREE.Points(g, m); pts.frustumCulled = false;
    this.galaxy.add(pts);
    this.galaxyMat = m;
    // the two of us
    const pair = pointsGeometry(2, (i) => ({ p: [0, 0, 0], c: i ? col("#ff8fb1") : col("#ffd89a"), s: 1, ph: 0.2 + i * 0.3 }));
    this.pairMat = pointsMaterial(this.shared, { size: 22, maxPx: 90 });
    this.pair = new THREE.Points(pair, this.pairMat); this.pair.frustumCulled = false;
    this.galaxy.add(this.pair);
    this.galaxy.rotation.x = 1.12;
    this.galaxy.position.set(0, -2.9, this.anchorZ(0) - 6);
    this.scene.add(this.galaxy);
  }

  /* ---------- prologue: one orbit around the sun ---------- */
  buildRing() {
    const k = this.stops.findIndex((s) => s.type === "prologue");
    this.ringK = k;
    if (k < 0) return;
    const N = 2600;
    const g = pointsGeometry(N, () => {
      const a = Math.random() * TAU;
      const j = (Math.random() + Math.random() - 1) * 0.06;
      return { p: [Math.cos(a) * (1 + j), Math.sin(a) * (1 + j), (Math.random() - 0.5) * 0.06], c: Math.random() < 0.8 ? col("#f2c27b") : col("#fff1d6"), s: rand(0.4, 1.1), x: a };
    });
    this.ringU = { uHead: { value: 0 } };
    this.ringMat = pointsMaterial(this.shared, {
      size: 1.6, maxPx: 20, uniforms: this.ringU, decl: "uniform float uHead;",
      transform: "float df = mod(uHead - aX, 6.28318); boost = 0.45 + exp(-df * 2.2) * 3.2;"
    });
    this.ring = new THREE.Points(g, this.ringMat); this.ring.frustumCulled = false;
    const earth = pointsGeometry(1, () => ({ p: [0, 0, 0], c: col("#bfe0ff"), s: 1, ph: 0.5 }));
    this.earthMat = pointsMaterial(this.shared, { size: 9, maxPx: 60 });
    this.earth = new THREE.Points(earth, this.earthMat); this.earth.frustumCulled = false;
    this.ringGroup = new THREE.Group();
    this.ringGroup.add(this.ring, this.earth);
    this.ringGroup.position.set(0, 0, this.anchorZ(k));
    this.scene.add(this.ringGroup);
  }

  /* ---------- day one: a small big bang ---------- */
  buildDayOne() {
    const k = this.stops.findIndex((s) => s.type === "dayone");
    this.dayK = k;
    if (k < 0) return;
    const N = matchMedia("(max-width: 760px)").matches ? 1200 : 2400;
    const g = pointsGeometry(N, () => {
      const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      return { p: [v.x, v.y, v.z], c: Math.random() < 0.7 ? col("#ffe2a8") : col("#ff8fb1"), s: rand(0.4, 1.3), x: rand(0.35, 1) };
    });
    this.dayU = { uSpread: { value: 0 } };
    this.dayMat = pointsMaterial(this.shared, {
      size: 2.4, maxPx: 26, uniforms: this.dayU, decl: "uniform float uSpread;",
      transform: "p = position * (0.15 + uSpread * aX * 7.0); boost = 1.0 + (1.0 - uSpread) * 1.5;"
    });
    this.day = new THREE.Points(g, this.dayMat); this.day.frustumCulled = false;
    this.day.position.set(0, 0, this.anchorZ(k) - 2);
    this.scene.add(this.day);
  }

  /* ---------- finale: stardust that becomes a heart ---------- */
  buildHeart() {
    const k = this.stops.findIndex((s) => s.type === "question");
    this.qK = k; this.letterK = this.stops.findIndex((s) => s.type === "letter");
    if (k < 0) return;
    const N = matchMedia("(max-width: 760px)").matches ? 4200 : 9000;
    const hx = (t) => 16 * Math.pow(Math.sin(t), 3);
    const hy = (t) => 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const cA = col("#ff8fb1"), cB = col("#ffd89a"), cC = col("#ff5f8f");
    const g = pointsGeometry(N, () => {
      const t = Math.random() * TAU;
      const shell = Math.random() < 0.62;
      const r = shell ? 1 + (Math.random() - 0.5) * 0.06 : Math.pow(Math.random(), 0.5);
      const zr = (1 - r * r * 0.7) * 5.5 * (Math.random() - 0.5) * 2;
      const p = [hx(t) * r, hy(t) * r + 2, shell ? (Math.random() - 0.5) * 2.2 : zr];
      const a = Math.random() * TAU, rr = rand(6, 40);
      const scatter = [Math.cos(a) * rr, rand(-14, 14), Math.sin(a) * rr];
      const c = Math.random() < 0.55 ? cA : Math.random() < 0.6 ? cB : cC;
      return { p, c, s: shell ? rand(0.6, 1.4) : rand(0.3, 0.9), x: Math.random(), v3: { aScatter: scatter } };
    });
    this.heartU = { uMorph: { value: 0 }, uBeat: { value: 1 }, uBurst: { value: 0 }, uLevel: { value: 0 } };
    this.heartMat = pointsMaterial(this.shared, {
      size: 2.2, maxPx: 22, uniforms: this.heartU,
      decl: "uniform float uMorph; uniform float uBeat; uniform float uBurst; uniform float uLevel; attribute vec3 aScatter;",
      transform: `
        float m = clamp(uMorph * 1.5 - aX * 0.5, 0.0, 1.0); m = m * m * (3.0 - 2.0 * m);
        vec3 sc = aScatter; float a = (1.0 - m) * (2.5 + aPhase * 4.0) + uTime * 0.04 * (1.0 - m);
        sc.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * sc.xz;
        float b = pow(max(sin(uTime * 3.0), 0.0), 10.0) + 0.6 * pow(max(sin(uTime * 3.0 - 0.7), 0.0), 10.0);
        vec3 hp = position * (1.0 + uBeat * b * 0.05 + uLevel * 0.04);
        hp += normalize(position + vec3(0.0, -2.0, 0.001)) * uBurst * (3.0 + aPhase * 16.0);
        p = mix(sc, hp, m);
        p.y += sin(uTime * 0.9 + aPhase * 20.0) * 0.12;
        boost = 0.55 + m * 0.55 + uBurst * 0.8 + uLevel * 0.5 + b * 0.25 * m;`
    });
    this.heart = new THREE.Points(g, this.heartMat); this.heart.frustumCulled = false;
    this.heart.renderOrder = 3;
    this.scene.add(this.heart);
  }

  /* ---------- shooting stars (attached to the camera) ---------- */
  buildShooting() {
    for (let i = 0; i < 6; i++) {
      const u = { uP: { value: 2 } };
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `uniform float uP; varying vec2 vUv;
          void main(){ float head = pow(vUv.x, 4.0); float w = 1.0 - abs(vUv.y - 0.5) * 2.0;
            float life = smoothstep(0.0, 0.15, uP) * (1.0 - smoothstep(0.6, 1.0, uP));
            gl_FragColor = vec4(1.0, 0.92, 0.82, head * w * w * life); }`,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
      }));
      m.visible = false; m.renderOrder = 5;
      this.camera.add(m);
      this.shooting.push({ m, u, t: 2, dur: 1, from: new THREE.Vector2(), dir: new THREE.Vector2() });
    }
  }
  shoot() {
    const s = this.shooting.find((o) => o.t >= 1);
    if (!s) return;
    const z = -30, hh = Math.tan((this.camera.fov * Math.PI) / 360) * 30, hw = hh * this.camera.aspect;
    const goLeft = Math.random() < 0.5;
    s.dir.set(goLeft ? -1 : 1, -rand(0.25, 0.6)).normalize();
    s.from.set(goLeft ? rand(0, hw) : rand(-hw, 0), rand(hh * 0.15, hh * 0.95));
    s.len = rand(5, 10); s.dist = rand(12, 22); s.t = 0; s.dur = rand(0.7, 1.2);
    s.m.position.z = z; s.m.rotation.z = Math.atan2(s.dir.y, s.dir.x);
    s.m.scale.set(s.len, 0.06, 1); s.m.visible = true;
  }

  /* ---------- fireworks for the YES ---------- */
  buildFireworks() {
    const cols = ["#ffd89a", "#ff8fb1", "#b9a8ff", "#fff1d6", "#ff6f9a"];
    for (let i = 0; i < 6; i++) {
      const c = col(cols[i % cols.length]);
      const g = pointsGeometry(320, () => {
        const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.6, 1));
        return { p: [v.x, v.y, v.z], c, s: rand(0.5, 1.3) };
      });
      const u = { uT: { value: 0 } };
      const m = pointsMaterial(this.shared, {
        size: 2.6, maxPx: 24, uniforms: u, decl: "uniform float uT;",
        transform: "p = position * (1.0 - exp(-uT * 3.0)) * 4.2; p.y -= uT * uT * 0.5; boost = (1.0 - smoothstep(0.4, 2.0, uT)) * 2.2;"
      });
      const pts = new THREE.Points(g, m); pts.visible = false; pts.frustumCulled = false; pts.renderOrder = 4;
      this.scene.add(pts);
      this.fireworks.push({ pts, u, live: false });
    }
  }
  burstAt(x, y, z) {
    const f = this.fireworks.find((o) => !o.live) || this.fireworks[0];
    f.pts.position.set(x, y, z); f.u.uT.value = 0; f.live = true; f.pts.visible = true;
  }

  /* ---------- chapter photos ---------- */
  buildChapters() {
    this.chapters = [];
    this.stops.forEach((s, k) => {
      if (s.type !== "chapter") return;
      const total = s.photos.length;
      const cards = s.photos.map((f, i) => {
        const t = f ? this.blank : placeholderTexture(s.date, i, total);
        const c = new Card(this.shared, t, s.placeholder ? "#f2c27b" : s.palette ? s.palette[1] : "#f2c27b");
        c.file = f || null; c.ready = !f;
        const id = f ? f.replace(/\.jpg$/, "") : null;
        if (id && this.media[id]) c.imgAspect = this.media[id].a;
        if (id) c.mesh.userData.pick = { key: s.key, id };
        this.cards.push(c);
        this.scene.add(c.mesh);
        return c;
      });
      this.chapters.push({ k, stop: s, cards, side: this.chapters.length % 2 === 0 ? 1 : -1 });
    });
  }

  /* where each photo sits around its stop, for the current screen shape */
  layout() {
    (this.chapters || []).forEach((ch) => this.layoutChapter(ch));
    (this.lanes || []).forEach((ln) => this.layoutLane(ln));
    if (this.memories) {
      // ring around the "One year, counted" panel; photos fade out wherever they'd cross the text
      const fh = Math.tan((this.baseFov * Math.PI) / 360) * (HOLD + MEM_BACK), fw = fh * this.aspect;
      const m = this.memories;
      m.rx = this.mobile ? fw * 0.78 : fw * 0.86; m.ry = this.mobile ? fh * 0.84 : fh * 0.8;
      m.bx = this.mobile ? fw * 0.95 : fw * 0.7; m.by = this.mobile ? fh * 0.56 : fh * 0.5;
      m.cards.forEach((c, i) => {
        c.orbit = { a: (i / m.cards.length) * TAU, z: (i % 3) * 0.25 };
        c.size(this.mobile ? 1.15 : 1.45, this.mobile ? 1.6 : 2.2);
      });
    }
    if (this.ringGroup) this.ringGroup.scale.setScalar(this.mobile ? 2.05 : 3.5 * Math.max(0.8, this.xScale));
    if (this.heart) {
      // sits between the subtitle and the buttons, so neither is covered
      const sc = this.mobile ? 0.082 : 0.096;
      this.heart.scale.setScalar(sc);
      this.heart.position.set(0, this.mobile ? -0.7 : -0.95, this.anchorZ(this.qK) - 1);
    }
  }

  /* the photos at a stop: a collage inside the free part of the screen (beside the text on
     desktop, above it on phones), computed from the real aspect ratios so nothing overlaps */
  layoutChapter(ch) {
    const fh = Math.tan((this.baseFov * Math.PI) / 360) * HOLD, fw = fh * this.aspect;
    let x0, x1, y0, y1;
    if (this.mobile) {
      // the text block starts at a different height in every chapter: stop the photos just above it
      const f = (this.textTop && this.textTop[ch.k]) || 0.55;
      x0 = -fw + 0.22; x1 = fw - 0.22; y1 = fh - 0.7; y0 = Math.min(y1 - 1.6, fh - 2 * fh * f + 0.35);
    }
    else if (ch.side > 0) { x0 = 0.45; x1 = fw - 0.55; y0 = -fh + 0.75; y1 = fh - 0.8; }
    else { x0 = -fw + 0.55; x1 = -0.45; y0 = -fh + 0.75; y1 = fh - 0.8; }
    const g = this.mobile ? 0.14 : 0.22;
    const rects = collage(ch.cards.map((c) => clamp(c.imgAspect || 0.75, 0.5, 2.0)), x1 - x0, y1 - y0, g);
    const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
    ch.cards.forEach((c, i) => {
      const r = rects[i]; if (!r) return;
      c.setRect(r.w, r.h);
      const cx = x0 + r.x + r.w / 2, cy = y1 - r.y - r.h / 2;
      c.base = { x: cx, y: cy, z: this.anchorZ(ch.k), dx: (cx - cx0) * 0.18, dy: (cy - cy0) * 0.15, hero: i === 0,
                 side: this.mobile ? (cx >= 0 ? 1 : -1) : ch.side };
      c.u.uRadius.value = Math.min(r.w, r.h) * 0.035;
    });
  }

  /* the app tells us where each chapter's text starts (fraction of the screen from the top) */
  setTextTops(t) {
    this.textTop = t;
    if (this.chapters) this.chapters.forEach((ch) => this.layoutChapter(ch));
  }

  /* "time flies": the rest of a chapter's photos line the corridor to the next scene,
     alternating sides (left/right on desktop, above/below on phones) so each one is seen whole */
  layoutLane(ln) {
    const z0 = this.anchorZ(ln.k);
    this.laneFar = this.mobile ? LANE_FAR_M : LANE_FAR_D; this.laneFull = this.mobile ? LANE_FULL_M : LANE_FULL_D;
    ln.cards.forEach((c, i) => {
      // desktop: upper-right, lower-left, lower-right, upper-left... so two photos on the same side
      // are never in the same half of the screen. phone: above / below the flight line.
      const q = i % 4, side = q === 0 || q === 2 ? 1 : -1, up = q === 0 || q === 3 ? 1 : -1;
      const a = clamp(c.imgAspect || 0.75, 0.5, 2.0);
      const j = Math.sin(i * 12.9898 + ln.k * 3.1) * 0.5 + 0.5; // stable jitter
      let w, h, x, y;
      if (this.mobile) {
        h = a > 1.15 ? 1.45 : 2.0; w = Math.min(h * a, 3.3); h = w / a;
        x = (j - 0.5) * 0.9; y = (i % 2 ? -1 : 1) * (LANE_IN_M + h / 2);
      } else {
        h = a > 1.15 ? 2.0 : 2.6; w = Math.min(h * a, 3.6); h = w / a;
        x = side * (LANE_IN_D + w / 2 + j * 0.5); y = up * (0.14 + h / 2);
      }
      c.setRect(w, h);
      c.base = { x, y, z: z0 - (i + 1) * LANE_GAP, side: this.mobile ? (i % 2 ? -1 : 1) : side };
      c.u.uRadius.value = Math.min(w, h) * 0.035;
    });
  }

  /* corridor cards: one per remaining photo of a chapter, streamed in as the camera nears */
  buildLanes() {
    this.lanes = [];
    this.stops.forEach((s, k) => {
      if (s.type !== "lane-a") return;
      const cards = s.lane.media.map((id) => {
        const m = this.media[id] || {};
        const c = new Card(this.shared, this.blank, m.v ? "#ffd27a" : s.lane.rim || "#f2c27b");
        c.file = id; c.ready = false; c.imgAspect = m.a || 0.75;
        c.mesh.userData.pick = { key: s.lane.key, id };
        c.mesh.visible = false;
        this.cards.push(c);
        this.scene.add(c.mesh);
        return c;
      });
      this.lanes.push({ k, lane: s.lane, cards });
    });
  }

  /* ---------- stats: every photo orbiting at once ---------- */
  buildMemories() {
    const k = this.stops.findIndex((s) => s.type === "stats");
    if (k < 0) return;
    const group = new THREE.Group();
    group.position.set(0, 0, this.anchorZ(k) - MEM_BACK);
    const N = this.mobile ? 12 : 14, step = Math.max(1, this.photoFiles.length / N);
    const pick = [];
    for (let x = 0; x < this.photoFiles.length && pick.length < N; x += step) pick.push(this.photoFiles[Math.floor(x)]);
    const cards = pick.map((f) => {
      const c = new Card(this.shared, this.blank, "#b9a8ff");
      c.file = f; c.ready = false;
      c.u.uReveal.value = 1; group.add(c.mesh);
      return c;
    });
    const n = cards.length, pos = new Float32Array(n * 3);
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.LineLoop(lg, new THREE.LineBasicMaterial({ color: 0xf2c27b, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false;
    group.add(line);
    this.scene.add(group);
    this.memories = { k, group, cards, line, pos };
  }

  /* ---------- per-frame ---------- */
  camAt(s) {
    if (s < 0) return HOLD - s * D * 0.75;
    const n = this.A.length - 1, k = Math.min(Math.floor(s), n), u = s - k;
    if (k >= n) return this.A[n] + HOLD;
    // dwell at each stop (eased), but glide at constant speed through a corridor so every photo gets its moment
    const a = this.opts.reduced ? 0.4 : 0.82;
    const g = this.stops[k].type === "lane-a" ? u : u - (a * Math.sin(TAU * u)) / TAU;
    return this.A[k] + HOLD + (this.A[k + 1] - this.A[k]) * g;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const pr = Math.min(devicePixelRatio || 1, w < 760 ? 1.5 : 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.shared.uPR.value = pr;
    this.camera.aspect = w / h;
    this.neb.uRes.value.set(w * pr, h * pr);
    const was = this.mobile;
    this.measureMode();
    this.baseFov = this.mobile ? 58 : this.aspect < 1.3 ? 52 : 45;
    if (this.chapters && (was !== this.mobile || true)) this.layout();
    this.camera.updateProjectionMatrix();
  }

  celebrate() {
    if (!this.heartU) return;
    const g = window.gsap;
    g.timeline()
      .to(this.heartU.uBurst, { value: 1, duration: 1.1, ease: "expo.out" })
      .to(this.heartU.uBurst, { value: 0, duration: 3.2, ease: "power3.inOut" });
    g.fromTo(this.neb.uPulse, { value: 1 }, { value: 0.25, duration: 5, ease: "power2.out" });
    const z = this.heart.position.z;
    for (let i = 0; i < 14; i++) {
      setTimeout(() => {
        const sp = this.mobile ? 1.6 : 4.5;
        this.burstAt(rand(-sp, sp), rand(-1.5, 3), z + rand(-4, 0));
        if (Math.random() < 0.7) this.shoot();
      }, i * 420 + Math.random() * 200);
    }
  }

  update(dt, sTarget) {
    const dtF = Math.min(dt, 0.25);
    dt = Math.min(dt, 0.05);
    // hand at most one new photo per frame to the GPU (two on desktop)
    if (this.upQ && this.upQ.length) { const n = this.mobile ? 1 : 2; let i = 0; while (i < n && this.upQ.length) if (this.upQ.shift()()) i++; }
    this.time += dt;
    this.shared.uTime.value = this.time;

    // smooth follow of the scroll position (adds weight on touch screens)
    const target = sTarget + this.intro;
    const prev = this.s;
    this.s += (target - this.s) * (1 - Math.exp(-dtF * 14));
    const v = (this.s - prev) / Math.max(dtF, 1e-4);
    this.vel += (v - this.vel) * (1 - Math.exp(-dt * 6));
    const av = Math.abs(this.vel);
    const s = this.s;

    this.streamT = (this.streamT || 0) - dt;
    if (this.streamT <= 0 && this.chapters) { this.streamT = 0.25; this.stream(s); }

    this.updateTilt(dtF);
    const tX = this.motionOn ? this.tilt.x : 0, tY = this.motionOn ? this.tilt.y : 0;

    // pointer parallax
    this.ptr.x += (this.ptr.tx - this.ptr.x) * (1 - Math.exp(-dt * 3));
    this.ptr.y += (this.ptr.ty - this.ptr.y) * (1 - Math.exp(-dt * 3));

    // camera
    const cam = this.camera;
    const z = this.camAt(s);
    const swayX = Math.sin(s * 1.3) * 0.45, swayY = Math.cos(s * 0.9) * 0.28;
    cam.position.set(swayX + this.ptr.x * 0.55, swayY - this.ptr.y * 0.35, z);
    cam.lookAt(swayX * 0.3, swayY * 0.3 - this.ptr.y * 0.1, z - 14);
    cam.rotation.z += Math.sin(s * 0.6) * 0.035 + clamp(this.vel, -2, 2) * 0.02;
    const fov = this.baseFov + clamp(av * 3.2, 0, 9);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.shared.uCamZ.value = z;

    // nebula palette follows the story
    const k0 = clamp(Math.floor(s), 0, this.palettes.length - 1), k1 = clamp(k0 + 1, 0, this.palettes.length - 1);
    const u0 = smooth(0.25, 0.85, s - Math.floor(s));
    this.neb.uC1.value.copy(this.palettes[k0][0]).lerp(this.palettes[k1][0], u0);
    this.neb.uC2.value.copy(this.palettes[k0][1]).lerp(this.palettes[k1][1], u0);
    this.neb.uOffset.value.set(this.ptr.x * 0.04 + s * 0.05, -this.ptr.y * 0.03 + Math.sin(s * 0.5) * 0.08);
    this.neb.uTO.value.set(-tX * 0.32, tY * 0.26);
    this.neb.uDrift.value = s * 0.35;
    this.neb.uPulse.value = Math.max(this.neb.uPulse.value * 0.985, this.level * 0.35);

    // speed lines + dust
    this.lineU.uStretch.value = clamp(av * 4.5, 0, 9);
    this.lineU.uAlpha.value = clamp((av - 0.15) * 0.7, 0, 0.75);

    // galaxy (inner arms rotate faster than outer — differential rotation)
    this.galaxyU.uRot.value += dt * (0.05 + av * 0.5);
    this.galaxyMat.uniforms.uFade.value = 1 - smooth(0.7, 1.5, s);
    this.galaxy.visible = s < 1.6;
    if (this.galaxy.visible) {
      const pp = this.pair.geometry.attributes.position.array;
      const a = this.time * 0.55 + s * 3;
      const rr = 0.55 + Math.max(0, -this.intro) * 1.2;
      pp[0] = Math.cos(a) * rr; pp[1] = 0.05; pp[2] = Math.sin(a) * rr;
      pp[3] = -Math.cos(a) * rr; pp[4] = -0.05; pp[5] = -Math.sin(a) * rr;
      this.pair.geometry.attributes.position.needsUpdate = true;
      this.pairMat.uniforms.uFade.value = this.galaxyMat.uniforms.uFade.value;
    }

    // prologue ring: the earth makes one lap as you scroll past
    if (this.ringGroup) {
      const u = s - this.ringK;
      this.ringGroup.visible = u > -1.6 && u < 1.2;
      const head = -Math.PI / 2 - (u + 1) * Math.PI;
      this.ringU.uHead.value = ((head % TAU) + TAU) % TAU;
      this.earth.position.set(Math.cos(head), Math.sin(head), 0.01);
      this.ringGroup.rotation.z = Math.sin(this.time * 0.1) * 0.05;
      this.ringGroup.rotation.x = -0.18 + u * 0.15;
      const f = smooth(-1.4, -0.6, u) * (1 - smooth(0.25, 0.7, u));
      this.ringMat.uniforms.uFade.value = f; this.earthMat.uniforms.uFade.value = f;
    }

    // day one burst
    if (this.day) {
      const u = s - this.dayK;
      this.day.visible = u > -1.3 && u < 1;
      this.dayU.uSpread.value = smooth(-0.9, 0.5, u);
      this.dayMat.uniforms.uFade.value = smooth(-1.3, -0.8, u) * (1 - smooth(0.3, 0.8, u));
      this.day.rotation.y = this.time * 0.05 + u * 0.6;
    }

    // chapters
    const vb = clamp(this.vel, -3, 3);
    (this.chapters || []).forEach((ch) => {
      const u = s - ch.k;
      const vis = u > -1.35 && u < 1.0;
      ch.cards.forEach((c, i) => {
        c.mesh.visible = vis;
        if (!vis) return;
        const b = c.base;
        const exit = smooth(0.08, 0.7, u);
        const enter = smooth(-1.2, -0.55, u);
        let x = b.x + b.dx * u * 1.6, y = b.y + b.dy * u * 1.2 + Math.sin(this.time * 0.5 + c.phase) * 0.07;
        // part like doors as the camera passes through
        const len = Math.hypot(x, y) || 1;
        const push = exit * exit * (b.hero ? 7 : 9);
        x += (x / len) * push * (this.mobile ? 0.8 : 1); y += (y / len) * push * 0.6;
        c.mesh.position.set(x + tX * 0.06, y - tY * 0.05, b.z);
        c.mesh.rotation.set(
          Math.sin(this.time * 0.35 + c.phase) * 0.03 + (b.y > 0 ? -1 : 1) * exit * 0.3 - tY * 0.09,
          -b.side * (this.mobile ? 0 : 0.16) - Math.sign(x || b.side) * exit * 0.95 + this.ptr.x * 0.04 + tX * 0.12,
          Math.sin(this.time * 0.27 + c.phase) * 0.025 + (i % 2 ? 0.035 : -0.025)
        );
        c.u.uReveal.value = smooth(-0.95, -0.25, u + i * 0.04);
        c.u.uOpacity.value = c.ready ? enter * (1 - smooth(0.75, 1.0, u)) : 0;
        c.u.uFocus.value = (1 - smooth(0.18, 0.55, Math.abs(u))) * (b.hero ? 1 : 0.95);
        c.u.uVel.value = vb;
      });
    });

    // time-flies corridors: photos hang along the path and drift past as the camera glides through
    this.laneNow = null;
    let best = 1e9;
    (this.lanes || []).forEach((ln) => {
      if (!ln.cards.length) return;
      const zs = ln.cards[0].base.z, ze = ln.cards[ln.cards.length - 1].base.z;
      const active = z - zs < 70 && z - ze > -6;
      ln.cards.forEach((c, i) => {
        const d = z - c.base.z; // how far ahead of the camera
        const vis = active && d > -1.5 && d < this.laneFar + 2;
        c.mesh.visible = vis;
        if (!vis) return;
        const b = c.base;
        c.mesh.position.set(b.x + tX * 0.06, b.y + Math.sin(this.time * 0.6 + c.phase) * 0.06 - tY * 0.05, b.z);
        c.mesh.rotation.set(
          Math.sin(this.time * 0.3 + c.phase) * 0.03 - (this.mobile ? b.side * 0.12 : 0) - tY * 0.09,
          (this.mobile ? 0 : -b.side * 0.24) + tX * 0.12,
          Math.sin(this.time * 0.25 + c.phase) * 0.025 + (i % 2 ? 0.02 : -0.02)
        );
        c.u.uOpacity.value = c.ready ? smooth(this.laneFar, this.laneFull, d) * smooth(0.4, 3.0, d) : 0;
        c.u.uReveal.value = smooth(this.laneFar, this.laneFull - 2, d);
        c.u.uFocus.value = 0.6 + 0.4 * smooth(this.laneFull, this.laneFull * 0.5, d);
        c.u.uVel.value = vb;
        if (d > 2.5 && d < this.laneFull && d < best) { best = d; this.laneNow = { key: ln.lane.key, id: c.file, i, n: ln.cards.length }; }
      });
    });

    // memories orbit
    if (this.memories) {
      const m = this.memories, u = s - m.k;
      const vis = u > -1.3 && u < 1.1;
      m.group.visible = vis;
      if (vis) {
        const rot = this.time * 0.06 + u * 1.4;
        const f = smooth(-1.2, -0.5, u) * (1 - smooth(0.4, 0.95, u));
        m.cards.forEach((c, i) => {
          const o = c.orbit, a = o.a + rot;
          const spread = 1 + smooth(0.1, 0.9, u) * 1.6 + (1 - smooth(-1, -0.2, u)) * 0.8;
          const x = Math.cos(a) * m.rx * spread, y = Math.sin(a) * m.ry * spread;
          c.mesh.position.set(x, y, o.z + Math.sin(this.time * 0.4 + i) * 0.15);
          c.mesh.rotation.set(0, -x * 0.03, Math.sin(this.time * 0.3 + i) * 0.04);
          // keep the numbers readable: fade a photo out while it overlaps the text panel
          const out = Math.max(Math.abs(x) - (m.bx + (c.w || 1) / 2), Math.abs(y) - (m.by + (c.h || 1.4) / 2));
          c.u.uOpacity.value = c.ready ? f * smooth(-0.2, 0.5, out) : 0; c.u.uFocus.value = 0.8; c.u.uVel.value = vb;
          m.pos[i * 3] = x; m.pos[i * 3 + 1] = y; m.pos[i * 3 + 2] = c.mesh.position.z - 0.05;
        });
        m.line.geometry.attributes.position.needsUpdate = true;
        m.line.material.opacity = 0.22 * f;
      }
    }

    // heart
    if (this.heart) {
      const uL = s - this.letterK;
      this.heart.visible = uL > -1.4;
      this.heartMat.uniforms.uFade.value = smooth(-1.4, -0.6, uL);
      this.heartU.uMorph.value = smooth(-0.3, this.qK - this.letterK - 0.1, uL);
      this.heartU.uLevel.value = this.level;
      this.heart.rotation.y = Math.sin(this.time * 0.35) * 0.25 + (1 - this.heartU.uMorph.value) * this.time * 0.1;
    }

    // shooting stars
    this.nextShoot -= dt;
    if (this.nextShoot < 0) { this.shoot(); this.nextShoot = rand(3.5, 8); }
    this.shooting.forEach((o) => {
      if (o.t >= 1) { o.m.visible = false; return; }
      o.t += dt / o.dur; o.u.uP.value = o.t;
      const d = o.t * o.dist;
      o.m.position.x = o.from.x + o.dir.x * d - o.dir.x * o.len * 0.5;
      o.m.position.y = o.from.y + o.dir.y * d - o.dir.y * o.len * 0.5;
    });
    this.fireworks.forEach((f) => {
      if (!f.live) return;
      f.u.uT.value += dt;
      if (f.u.uT.value > 2.2) { f.live = false; f.pts.visible = false; }
    });

    this.renderer.render(this.scene, cam);
  }
}
