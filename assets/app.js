/* ==================================================================
   ONE ORBIT — app (React + GSAP ScrollTrigger + Lenis)
   Text components are React Bits patterns (SplitText, ScrollFloat,
   ScrollReveal, ScrollVelocity, CountUp, CircularText, ShinyText)
   rebuilt here so they all share one scroll engine.
   ================================================================== */

const { useEffect, useLayoutEffect, useRef, useState } = React;
const html = htm.bind(React.createElement);
gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

const CFG = window.CONFIG;
const STOPS = window.STOPS;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE = matchMedia("(pointer: fine)").matches;
const DAY = 86400000;
const START = new Date(CFG.startDate + "T00:00:00");
const DAYS = Math.max(0, Math.floor((Date.now() - START.getTime()) / DAY));
const MEDIA = window.MEDIA || {};
const PHOTO_COUNT = new Set(STOPS.flatMap((s) => s.media || (s.photos || []).filter(Boolean))).size;
const CHAPTERS = STOPS.filter((s) => s.type === "chapter");
const CAPS = {}; CHAPTERS.forEach((c) => (c.hero || []).forEach((h) => (CAPS[h.id] = h.cap)));
// the flight path: every stop except marquees; a corridor ("lane") is two stops, its start and its end
const PATH = STOPS.flatMap((s) => s.type === "marquee" ? [] : s.type === "lane"
  ? [{ type: "lane-a", lane: s }, { type: "lane-b", lane: s }] : [s]);
// phone layout = narrow screens AND tall/portrait screens (portrait tablets), same rule as cosmos.js
const PHONE_Q = "(max-width: 760px), (max-aspect-ratio: 17/20)";
const isPhone = () => matchMedia(PHONE_Q).matches;
const SOFT = !isPhone(); // skip blur filters on phones (cheaper)
const FF_DOWN = 11, FF_UP = 4; // fast-forward: seconds to the end, seconds back
const bl = (n) => (SOFT ? `blur(${n}px)` : "none");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const app = (window.__orbit = {});

/* ================================================================
   SOUND — Khat through a Web Audio graph, plus generated effects
   ================================================================ */
class Sound {
  constructor() {
    this.on = true; this.started = false; this.lvl = 0;
    // the soundtrack: CFG.songs in order, crossfading into each other, looping back to the first
    this.tracks = (CFG.songs && CFG.songs.length) ? CFG.songs : [{ src: CFG.song, title: CFG.songTitle }];
    this.xf = CFG.crossfade ?? 6;
    this.cur = 0; this.fading = false; this.onTrack = null;
    this.els = this.tracks.map((t, i) => {
      const a = new Audio();
      a.src = t.src; a.preload = i === 0 ? "auto" : "metadata"; a.loop = this.tracks.length === 1;
      a.setAttribute("playsinline", "");
      a.addEventListener("error", () => { t.bad = true; if (i === this.cur && this.started) this.next(true); });
      a.addEventListener("timeupdate", () => {
        if (i !== this.cur || this.fading || this.tracks.length < 2 || !a.duration) return;
        if (a.duration - a.currentTime <= this.xf) this.next(false);
      });
      a.addEventListener("ended", () => { if (i === this.cur && this.tracks.length > 1) this.next(true); });
      return a;
    });
    this.failed = false;
    // opened by double-clicking (file://): browsers mute local audio routed through Web Audio,
    // so play the songs directly and crossfade with plain volume instead
    this.direct = location.protocol === "file:";
    if (this.direct) this.els.forEach((a, i) => { a.volume = i === 0 ? (CFG.songVolume ?? 0.85) : 0; });
  }
  get el() { return this.els[this.cur]; }
  fadeVol(a, to, sec, done) {
    clearInterval(a._fade); const from = a.volume, t0 = performance.now();
    a._fade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (sec * 1000));
      try { a.volume = Math.max(0, Math.min(1, from + (to - from) * k)); } catch (e) {}
      if (k >= 1) { clearInterval(a._fade); done && done(); }
    }, 50);
  }
  /* crossfade to the next playable song (skips any file that failed to load) */
  next(hard) {
    const n = this.tracks.length;
    let k = this.cur;
    for (let tries = 0; tries < n; tries++) { k = (k + 1) % n; if (!this.tracks[k].bad) break; }
    if (this.tracks[k].bad || k === this.cur) { if (this.tracks[this.cur].bad) { this.failed = true; this.fallback(); } return; }
    const old = this.cur, a = this.els[k];
    this.fading = true; this.cur = k;
    try { a.currentTime = 0; } catch (e) {}
    if (this.on) a.play().catch(() => {});
    const dur = hard ? 0.8 : this.xf;
    if (this.direct) { this.fadeVol(this.els[old], 0, dur); this.fadeVol(a, CFG.songVolume ?? 0.85, dur); }
    else if (this.ctx && this.tg) {
      const t = this.ctx.currentTime;
      this.tg[old].gain.cancelScheduledValues(t); this.tg[old].gain.setValueAtTime(this.tg[old].gain.value, t); this.tg[old].gain.linearRampToValueAtTime(0, t + dur);
      this.tg[k].gain.cancelScheduledValues(t); this.tg[k].gain.setValueAtTime(0, t); this.tg[k].gain.linearRampToValueAtTime(1, t + dur);
    }
    setTimeout(() => { if (this.cur !== old) this.els[old].pause(); this.fading = false; }, dur * 1000 + 100);
    this.onTrack && this.onTrack(this.tracks[k]);
  }
  start() {
    if (this.started) return;
    this.started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC(); } catch (e) { this.el.play().catch(() => {}); return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0; this.master.connect(c.destination);
    this.an = c.createAnalyser(); this.an.fftSize = 256; this.an.smoothingTimeConstant = 0.8;
    this.bins = new Uint8Array(this.an.frequencyBinCount);
    this.lp = c.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 420; this.lp.Q.value = 0.6;
    this.music = c.createGain(); this.music.gain.value = (CFG.songVolume ?? 0.85) * (this.vol ?? 1);
    this.music.connect(this.lp); this.lp.connect(this.master); this.lp.connect(this.an);
    // effects bus with a soft echo
    this.fx = c.createGain(); this.fx.gain.value = 0.9;
    const dl = c.createDelay(1); dl.delayTime.value = 0.34;
    const fb = c.createGain(); fb.gain.value = 0.32;
    const wet = c.createGain(); wet.gain.value = 0.35;
    this.fx.connect(this.master); this.fx.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(this.master);
    // whoosh: filtered noise that follows scroll speed
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const n = c.createBufferSource(); n.buffer = buf; n.loop = true;
    this.wf = c.createBiquadFilter(); this.wf.type = "bandpass"; this.wf.frequency.value = 700; this.wf.Q.value = 0.8;
    this.wg = c.createGain(); this.wg.gain.value = 0;
    n.connect(this.wf); this.wf.connect(this.wg); this.wg.connect(this.master); n.start();

    // every song gets its own gain so two can overlap during a crossfade
    if (!this.direct) this.tg = this.els.map((a, i) => {
      const g = c.createGain(); g.gain.value = i === 0 ? 1 : 0; g.connect(this.music);
      try { c.createMediaElementSource(a).connect(g); } catch (e) { /* plays straight to speakers */ }
      return g;
    });
    try { if (CFG.songStartAt) this.el.currentTime = CFG.songStartAt; } catch (e) {}
    this.el.play().catch(() => { this.tracks[0].bad = true; this.next(true); });
    // iPhones only let audio start from a tap: unlock the other songs now, silently, so crossfades work later
    this.els.slice(1).forEach((a) => { a.play().then(() => { a.pause(); try { a.currentTime = 0; } catch (e) {} }).catch(() => {}); });
    c.resume && c.resume();
    const t = c.currentTime;
    this.master.gain.setValueAtTime(0, t); this.master.gain.linearRampToValueAtTime(1, t + 2.2);
    this.lp.frequency.setValueAtTime(420, t); this.lp.frequency.exponentialRampToValueAtTime(19000, t + 5.5);
    document.addEventListener("visibilitychange", () => {
      if (!this.on) return;
      if (document.hidden) { this.el.pause(); c.suspend && c.suspend(); }
      else { c.resume && c.resume(); if (!this.failed) this.el.play().catch(() => {}); }
    });
  }
  /* if the mp3 can't play, a slow generated pad keeps the mood */
  fallback() {
    if (!this.ctx || this.pad) return;
    const c = this.ctx; this.pad = true;
    const chords = [[146.8, 220, 277.2, 370], [123.5, 185, 246.9, 293.7], [98, 196, 246.9, 370], [110, 164.8, 220, 329.6]];
    let i = 0;
    const play = () => {
      const t = c.currentTime;
      chords[i++ % chords.length].forEach((f) => {
        [-4, 4].forEach((det) => {
          const o = c.createOscillator(), g = c.createGain();
          o.type = "sawtooth"; o.frequency.value = f; o.detune.value = det;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.018, t + 1.6); g.gain.linearRampToValueAtTime(0, t + 5.2);
          o.connect(g); g.connect(this.music); o.start(t); o.stop(t + 5.4);
        });
      });
    };
    play(); setInterval(() => this.on && play(), 4500);
  }
  bell(f, v = 0.05, when = 0) {
    if (!this.ctx || !this.on) return;
    const c = this.ctx, t = c.currentTime + when;
    [[1, v], [2.76, v * 0.25], [5.4, v * 0.08]].forEach(([m, a]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = f * m;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6 / m);
      o.connect(g); g.connect(this.fx); o.start(t); o.stop(t + 2.8);
    });
  }
  chime(i) { const N = [1174.7, 1318.5, 1480, 1760, 1975.5, 2349.3]; this.bell(N[i % N.length], 0.035); }
  pluck() { this.bell(rand(520, 700), 0.03); }
  sparkle() {
    [1174.7, 1480, 1760, 2349.3, 2960, 3520, 2349.3, 2960].forEach((f, i) => this.bell(f, 0.04, i * 0.09));
    if (this.music && this.ctx) {
      const t = this.ctx.currentTime;
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setValueAtTime(this.music.gain.value, t);
      this.music.gain.linearRampToValueAtTime((CFG.songVolume ?? 0.85) * 1.15, t + 1.5);
    }
  }
  whoosh(v) {
    if (!this.wg) return;
    const t = this.ctx.currentTime;
    this.wg.gain.setTargetAtTime(this.on ? clamp((v - 0.25) * 0.05, 0, 0.07) : 0, t, 0.12);
    this.wf.frequency.setTargetAtTime(500 + clamp(v, 0, 4) * 500, t, 0.15);
  }
  level() {
    if (!this.an || !this.on) return 0;
    this.an.getByteFrequencyData(this.bins);
    let s = 0; for (let i = 1; i < 9; i++) s += this.bins[i];
    const v = s / (8 * 255);
    this.lvl += (v - this.lvl) * 0.2;
    return clamp((this.lvl - 0.35) * 1.6, 0, 1);
  }
  toggle() {
    this.on = !this.on;
    if (!this.ctx) return this.on;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.on ? 1 : 0, t + 0.6);
    if (this.on) { this.ctx.resume(); if (!this.failed) this.el.play().catch(() => {}); }
    else setTimeout(() => !this.on && this.el.pause(), 650);
    return this.on;
  }
  /* soften the song while a video with its own sound is playing */
  duck(down) {
    this.ducked = down;
    const full = (CFG.songVolume ?? 0.85) * (this.vol ?? 1);
    if (this.direct) { this.fadeVol(this.el, down ? full * 0.12 : full, 0.5); return; }
    if (!this.ctx || !this.music) return;
    const t = this.ctx.currentTime;
    this.music.gain.cancelScheduledValues(t);
    this.music.gain.setValueAtTime(this.music.gain.value, t);
    this.music.gain.linearRampToValueAtTime(down ? full * 0.12 : full, t + 0.5);
  }
  /* the player's volume slider (0..1) */
  setVolume(v) {
    this.vol = v;
    const g = (CFG.songVolume ?? 0.85) * v * (this.ducked ? 0.12 : 1);
    if (this.direct) { this.els.forEach((a, i) => { if (i === this.cur) try { a.volume = g; } catch (e) {} }); return; }
    if (!this.ctx || !this.music) return;
    const t = this.ctx.currentTime;
    this.music.gain.cancelScheduledValues(t); this.music.gain.setTargetAtTime(g, t, 0.03);
  }
}
const sound = (app.sound = new Sound());

/* ================================================================
   React Bits style text primitives
   ================================================================ */
function SplitText({ text, className = "" }) {
  const words = String(text).split(" ");
  return html`<span className=${"split " + className} aria-label=${text}>${words.map((w, wi) => html`
    <span className="sw" key=${wi} aria-hidden="true">${[...w].map((ch, ci) => html`<span className="ch" key=${ci}><span className="ci">${ch}</span></span>`)}</span>${wi < words.length - 1 ? " " : ""}`)}</span>`;
}
function RevealWords({ text, className = "" }) {
  const words = String(text).split(" ");
  return html`<span className=${"rv " + className}>${words.map((w, i) => html`<span className="rw" key=${i}>${w}${i < words.length - 1 ? " " : ""}</span>`)}</span>`;
}
function ShinyText({ text, className = "" }) {
  return html`<span className=${"shiny " + className}>${text}</span>`;
}
function CircularText({ text, radius = 74 }) {
  const chars = [...text];
  return html`<div className="circ" aria-hidden="true">${chars.map((c, i) => html`
    <span key=${i} style=${{ transform: `rotate(${(360 / chars.length) * i}deg) translateY(-${radius}px)` }}>${c}</span>`)}</div>`;
}

/* scrubbed timeline helper: the timeline spans section top→bottom over the viewport.
   a = moment the section pins, b = moment it unpins (both 0..1).
   The app's ticker moves every timeline from the same smoothed scroll position that moves the
   page (driveScrubs), so the words can never run late or early against their pinned section.
   Every exit finishes before the section unpins (b), so text never slides away half-visible. */
const SCRUBS = new Set();
function driveScrubs(y) {
  SCRUBS.forEach((r) => {
    const span = r.st.end - r.st.start; if (!(span > 0)) return;
    const p = clamp((y - r.st.start) / span, 0, 1);
    if (Math.abs(p - r.p) > 1e-5) { r.p = p; r.tl.progress(p); }
  });
}
function useScrub(ref, build, deps = []) {
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    let rec = null;
    const ctx = gsap.context(() => {
      const vh = innerHeight, h = el.offsetHeight, total = h + vh;
      const a = vh / total, b = h / total;
      const tl = gsap.timeline({ defaults: { ease: "none" }, paused: true });
      tl.set({}, {}, 1);
      build(tl, { a, b, w: b - a, el });
      const st = ScrollTrigger.create({ trigger: el, start: "top bottom", end: "bottom top" });
      rec = { tl, st, p: 0 }; SCRUBS.add(rec);
    }, el);
    return () => { if (rec) SCRUBS.delete(rec); ctx.revert(); };
  }, deps);
}

/* ================================================================
   Sections
   ================================================================ */
function Hero({ begun }) {
  const ref = useRef();
  const kick = DAYS >= 365 ? `One full orbit · day ${DAYS}` : `Day ${DAYS} of 365`;
  useEffect(() => {
    if (!begun) return;
    const el = ref.current;
    const tl = gsap.timeline({ delay: 0.6 });
    tl.fromTo(el.querySelectorAll(".hero-title .ci"),
      { yPercent: 110, opacity: 0, rotateX: -70, filter: bl(10) },
      { yPercent: 0, opacity: 1, rotateX: 0, filter: bl(0), duration: 1.8, ease: "expo.out", stagger: 0.055 })
      .fromTo(el.querySelectorAll(".hero-k, .hero-sub, .hero-cue"), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 1.4, ease: "power3.out", stagger: 0.15 }, 0.9);
    return () => tl.kill();
  }, [begun]);
  // on scroll: each letter leaves at its own speed
  useLayoutEffect(() => {
    const el = ref.current;
    const ctx = gsap.context(() => {
      const chars = el.querySelectorAll(".hero-title .ch");
      const tl = gsap.timeline({ scrollTrigger: { trigger: el, start: "top top", end: "bottom top", scrub: 0.5 } });
      chars.forEach((c, i) => tl.to(c, { y: -rand(120, 520), x: rand(-40, 40), rotate: rand(-25, 25), opacity: 0, filter: bl(6), ease: "power1.in", duration: 1 }, 0));
      tl.fromTo(el.querySelectorAll(".hero-k"), { y: 0, opacity: 1 }, { y: -160, opacity: 0, duration: 0.6, immediateRender: false }, 0)
        .fromTo(el.querySelectorAll(".hero-sub"), { y: 0, opacity: 1 }, { y: -90, opacity: 0, duration: 0.5, immediateRender: false }, 0)
        .fromTo(el.querySelectorAll(".hero-cue"), { opacity: 1 }, { opacity: 0, duration: 0.2, immediateRender: false }, 0);
    }, el);
    return () => ctx.revert();
  }, []);
  return html`<section className="sec sec-hero" data-stop="0" data-name="Cheeni & Atharva" ref=${ref}>
    <div className="hero-in">
      <p className="mono hero-k">26.10.2025 <span className="arrow">→</span> 26.10.2026</p>
      <h1 className="hero-title">
        <${SplitText} text=${CFG.her} className="l1" />
        <span className="amp-row"><${SplitText} text="&" className="amp" /> <${SplitText} text=${CFG.me} className="l2" /></span>
      </h1>
      <p className="hero-sub"><span className="serif-i">A year of us, told in stars.</span> <span className="hero-pill"><${ShinyText} className="mono" text=${kick} /></span></p>
    </div>
    <div className="hero-cue mono"><span>Scroll slowly</span><i></i></div>
  </section>`;
}

function Prologue({ stop, idx }) {
  const ref = useRef();
  useScrub(ref, (tl, { a, b, w }) => {
    const l = ref.current.querySelectorAll(".pro-line");
    tl.fromTo(l[0].querySelectorAll(".rw"), { opacity: 0, y: 30, filter: bl(10) }, { opacity: 1, y: 0, filter: bl(0), duration: w * 0.3, stagger: { amount: w * 0.12 } }, a - 0.05)
      .fromTo(l[1].querySelectorAll(".rw"), { opacity: 0, y: 30, filter: bl(10) }, { opacity: 1, y: 0, filter: bl(0), duration: w * 0.3, stagger: { amount: w * 0.14 } }, a + w * 0.25)
      .fromTo(l[0], { y: 40 }, { y: -40, duration: b - a + 0.1 }, a - 0.05)
      .fromTo(l[1], { y: 70 }, { y: -70, duration: b - a + 0.1 }, a - 0.05)
      .to(l, { opacity: 0, filter: bl(12), scale: 1.08, duration: w * 0.2, stagger: w * 0.04 }, a + w * 0.7);
  });
  return html`<section className="sec sec-pro" data-stop=${idx} data-name="One orbit" ref=${ref}>
    <div className="pin center">
      <div className="pro">
        <p className="pro-line"><${RevealWords} text=${stop.lines[0]} /></p>
        <p className="pro-line big"><${RevealWords} text=${stop.lines[1]} /></p>
      </div>
    </div>
  </section>`;
}

/* ================================================================
   CHAPTER MOTION: a little scene per chapter, on the TEXT side of the screen
   (never over the photos). Fluffle = a pair of bunnies, Monkey = him; they turn up
   through the story. Everything is driven by the chapter's own scroll timeline.
   Item types (x, y are 0..1 inside the text half; phones: the lower part of the screen):
     pop   - pops in at x/y (xs/ys for several), loops, pops out
     walk  - walks/hops in from `from` to `to`, leaves the same way it was going
     drift - crosses from `from` to `to` (and y0 -> y1) during `dur`
     rise / fall - several float up / drift down
     peek  - pops up from below to y, ducks back down
     bg    - a big faint shape behind the words
   plus a few drawn scenes (lanterns, fog, hot-air balloon, flight path, orbit, rain, rally, heartbeat).
   at / out / dur are fractions of the chapter's pinned scroll.
   ================================================================ */
const B = "🐇", M = "🐒";
const FXS = {
  before:     [{ t: "bg", e: "🌕", x: 0.8, y: 0.12, s: 96, op: 0.9, loop: "bob" }, { t: "fall", e: ["🌼", "🏵️", "🌼", "🌸"], n: 9, s: 30, loop: "spin", dur: 0.7 },
               { t: "peek", e: B, x: 0.16, y: 0.9, s: 64, at: 0.2, loop: "hop" }],
  pondy:      [{ t: "waves" }, { t: "drift", e: "🚗", from: -0.2, to: 1.2, y: 0.84, s: 64, at: 0.0, dur: 0.6, loop: "bob" },
               { t: "pop", e: ["🐚", "⛱️"], xs: [0.12, 0.88], ys: [0.1, 0.1], s: 52, at: 0.25, loop: "sway" }],
  diwali:     [{ t: "lanterns" }, { t: "pop", e: "🪔", xs: [0.08, 0.3, 0.7, 0.92], y: 0.93, s: 42, at: 0.04, stagger: 0.04, loop: "flicker" },
               { t: "peek", e: B, x: 0.5, y: 0.9, s: 56, at: 0.35, loop: "hop" }],
  dayone:     [{ t: "flash" }, { t: "bolt" }, { t: "walk", e: B, from: -0.15, to: 0.36, y: 0.9, s: 66, at: 0.12, loop: "hop" },
               { t: "walk", e: M, from: 1.15, to: 0.64, y: 0.9, s: 70, at: 0.12, loop: "hop" },
               { t: "pop", e: "❤️", x: 0.5, y: 0.86, s: 44, at: 0.3, loop: "pulse" }],
  firstweeks: [{ t: "pop", e: "📚", x: 0.14, y: 0.92, s: 64, at: 0.05 }, { t: "pop", e: B, x: 0.14, y: 0.8, s: 52, at: 0.12, loop: "bob" },
               { t: "rise", e: "💤", xs: [0.2, 0.24, 0.18], y0: 0.76, y1: 0.55, s: 26, at: 0.18, dur: 0.25, stagger: 0.12 },
               { t: "pop", e: "💐", x: 0.86, y: 0.9, s: 60, at: 0.28, loop: "sway" }],
  firstdate:  [{ t: "bg", e: "🛕", x: 0.84, y: 0.84, s: 180, op: 0.22 }, { t: "pop", e: "💍", x: 0.14, y: 0.1, s: 62, at: 0.2, loop: "sway" },
               { t: "pop", e: "✨", xs: [0.06, 0.24], ys: [0.04, 0.17], s: 34, at: 0.24, loop: "twinkle" },
               { t: "walk", e: B + M, from: -0.25, to: 0.24, y: 0.9, s: 54, at: 0.1, loop: "hop" }],
  munnar:     [{ t: "fog" }, { t: "hotair" }, { t: "fall", e: ["🍃", "🌿", "🍃"], n: 8, s: 30, loop: "spin", dur: 0.7 }],
  onemonth:   [{ t: "pop", e: "🎉", x: 0.1, y: 0.1, s: 60, at: 0.08, loop: "wiggle" }, { t: "pop", e: "🎊", x: 0.9, y: 0.12, s: 58, at: 0.14, loop: "wiggle" },
               { t: "walk", e: B, from: -0.15, to: 0.22, y: 0.9, s: 60, at: 0.15, loop: "hop" }, { t: "walk", e: M, from: 1.15, to: 0.78, y: 0.9, s: 66, at: 0.15, loop: "hop" },
               { t: "pop", e: "🥳", x: 0.5, y: 0.92, s: 48, at: 0.3, loop: "wiggle" }],
  ordinary:   [{ t: "pop", e: "☕", x: 0.12, y: 0.9, s: 58, at: 0.05, loop: "bob" }, { t: "drift", e: "🦟", from: -0.1, to: 0.8, y0: 0.2, y1: 0.12, s: 34, at: 0.1, dur: 0.38, loop: "buzz" },
               { t: "pop", e: "💥", x: 0.82, y: 0.12, s: 56, at: 0.48, out: 0.6, loop: "pulse" }, { t: "pop", e: "🏸", x: 0.86, y: 0.9, s: 58, at: 0.44, loop: "swing" }],
  citydate:   [{ t: "bg", e: "⛰️", x: 0.82, y: 0.86, s: 180, op: 0.22 }, { t: "pop", e: "🍦", x: 0.12, y: 0.9, s: 58, at: 0.1, loop: "bob" },
               { t: "pop", e: "🧇", x: 0.3, y: 0.92, s: 48, at: 0.18, loop: "sway" }, { t: "pop", e: M, x: 0.86, y: 0.12, s: 54, at: 0.22, loop: "bob" },
               { t: "rise", e: "💤", xs: [0.9, 0.94, 0.88], y0: 0.1, y1: 0.0, s: 22, at: 0.26, dur: 0.2, stagger: 0.1 }],
  parashy:    [{ t: "pop", e: "🍫", x: 0.12, y: 0.9, s: 58, at: 0.06, loop: "bob" }, { t: "pop", e: "☕", x: 0.3, y: 0.92, s: 48, at: 0.12, loop: "bob" },
               { t: "pop", e: "🎆", xs: [0.18, 0.8], ys: [0.1, 0.06], s: 58, at: 0.3, stagger: 0.1, loop: "pulse" }],
  birthday:   [{ t: "rise", e: ["🎈", "🎈", "🎈", "🎈"], xs: [0.08, 0.3, 0.7, 0.92], s: 54, at: -0.04, dur: 0.85, stagger: 0.07, loop: "sway" },
               { t: "pop", e: "🎂", x: 0.14, y: 0.9, s: 64, at: 0.12, loop: "bob" }, { t: "pop", e: "🍫", x: 0.32, y: 0.92, s: 46, at: 0.2, loop: "sway" },
               { t: "walk", e: B, from: 1.15, to: 0.84, y: 0.9, s: 58, at: 0.22, loop: "hop" }],
  january:    [{ t: "drift", e: "🪁", from: -0.15, to: 1.15, y0: 0.18, y1: 0.06, s: 62, at: 0.0, dur: 0.8, loop: "sway" },
               { t: "pop", e: "🍨", x: 0.12, y: 0.9, s: 54, at: 0.12, loop: "bob" }, { t: "pop", e: "🏆", x: 0.88, y: 0.9, s: 56, at: 0.24, loop: "wiggle" },
               { t: "pop", e: "🐱", x: 0.5, y: 0.93, s: 44, at: 0.34, loop: "bob" }],
  kodai:      [{ t: "pop", e: "🌲", xs: [0.05, 0.15, 0.85, 0.95], ys: [0.9, 0.92, 0.92, 0.9], ss: [78, 60, 64, 80], at: 0.0, stagger: 0.03, loop: "sway" },
               { t: "needles" }, { t: "drift", e: "☁️", from: 1.2, to: -0.2, y: 0.08, s: 70, at: -0.05, dur: 0.95 },
               { t: "pop", e: "☕", x: 0.5, y: 0.93, s: 46, at: 0.3, loop: "bob" }],
  dhruva:     [{ t: "pop", e: "😎", x: 0.14, y: 0.88, s: 70, at: 0.08, loop: "wiggle" }, { t: "rise", e: ["🎶", "🎵", "🎶", "🎵", "🎶"], n: 5, s: 34, at: 0.0, dur: 0.6, stagger: 0.1, loop: "sway" },
               { t: "pop", e: "🪩", x: 0.86, y: 0.1, s: 58, at: 0.14, loop: "spin" }],
  valentine:  [{ t: "bees" }, { t: "fall", e: ["🌹", "🥀", "🌹"], n: 7, s: 30, loop: "spin", dur: 0.7 },
               { t: "pop", e: "💌", x: 0.86, y: 0.9, s: 58, at: 0.2, loop: "bob" }, { t: "walk", e: B, from: -0.15, to: 0.16, y: 0.9, s: 56, at: 0.25, loop: "hop" }],
  spring:     [{ t: "holi" }, { t: "pop", e: "🎨", x: 0.12, y: 0.9, s: 60, at: 0.12, loop: "sway" }, { t: "pop", e: "🏆", x: 0.88, y: 0.92, s: 50, at: 0.24, loop: "wiggle" },
               { t: "pop", e: "🥳", x: 0.5, y: 0.93, s: 44, at: 0.34, loop: "wiggle" }],
  pondy2:     [{ t: "bg", e: "🌅", x: 0.84, y: 0.1, s: 120, op: 0.5 }, { t: "pop", e: "🥤", x: 0.12, y: 0.9, s: 62, at: 0.08, loop: "bob" },
               { t: "pop", e: "🧖‍♀️", x: 0.3, y: 0.92, s: 50, at: 0.16, loop: "wiggle" }, { t: "walk", e: B + M, from: 1.25, to: 0.78, y: 0.9, s: 52, at: 0.2, loop: "hop" }],
  ring:       [{ t: "fall", e: ["🌸", "🌸", "💮"], n: 11, s: 28, loop: "spin", dur: 0.75 }, { t: "pop", e: "💍", x: 0.86, y: 0.1, s: 64, at: 0.08, loop: "sway" },
               { t: "pop", e: "📚", x: 0.12, y: 0.9, s: 56, at: 0.2 }, { t: "pop", e: "❤️", x: 0.86, y: 0.1, s: 30, at: 0.16, out: 0.3, loop: "pulse" }],
  goodbye:    [{ t: "pop", e: "☕", x: 0.14, y: 0.9, s: 60, at: 0.06, loop: "bob" }, { t: "pop", e: "🍟", x: 0.32, y: 0.92, s: 48, at: 0.14, loop: "sway" },
               { t: "drift", e: "✈️", from: -0.15, to: 1.2, y0: 0.2, y1: 0.02, s: 58, at: 0.38, dur: 0.42 }],
  apart:      [{ t: "distance" }, { t: "pop", e: "📱", x: 0.12, y: 0.9, s: 58, at: 0.1, loop: "wiggle" },
               { t: "rise", e: ["💗", "💬", "💗"], xs: [0.2, 0.26, 0.16], y0: 0.82, y1: 0.55, s: 28, at: 0.2, dur: 0.3, stagger: 0.1 },
               { t: "pop", e: "🐵", x: 0.88, y: 0.9, s: 56, at: 0.26, loop: "bob" }, { t: "pop", e: "🌹", x: 0.82, y: 0.86, s: 32, at: 0.3, loop: "sway" }],
  sixmonths:  [{ t: "halforbit" }, { t: "pop", e: "🎂", x: 0.14, y: 0.9, s: 60, at: 0.2, loop: "bob" }, { t: "pop", e: "🎁", x: 0.32, y: 0.92, s: 48, at: 0.28, loop: "wiggle" }],
  kolkata:    [{ t: "drift", e: "🚕", from: 1.2, to: -0.25, y: 0.88, s: 68, at: 0.04, dur: 0.6, loop: "bob" }, { t: "pop", e: "🍕", x: 0.12, y: 0.1, s: 56, at: 0.15, loop: "wiggle" },
               { t: "pop", e: "😘", x: 0.88, y: 0.1, s: 54, at: 0.5, loop: "pulse" }],
  reunion:    [{ t: "drift", e: "🏍️", from: -0.25, to: 1.2, y: 0.88, s: 68, at: 0.1, dur: 0.6, loop: "bob" }, { t: "pop", e: "🍦", x: 0.12, y: 0.1, s: 54, at: 0.1, loop: "bob" },
               { t: "pop", e: "🎂", x: 0.88, y: 0.1, s: 54, at: 0.2, loop: "sway" }, { t: "pop", e: "🎉", x: 0.5, y: 0.06, s: 44, at: 0.3, loop: "wiggle" }],
  rameswaram: [{ t: "bg", e: "🛕", x: 0.84, y: 0.84, s: 180, op: 0.22 }, { t: "pop", e: "🔔", xs: [0.1, 0.24], y: 0.08, s: 46, at: 0.04, stagger: 0.05, loop: "swing" },
               { t: "walk", e: B, from: -0.15, to: 0.22, y: 0.9, s: 60, at: 0.15, loop: "hop" }, { t: "pop", e: "👕", x: 0.22, y: 0.8, s: 36, at: 0.3, loop: "wiggle" },
               { t: "pop", e: "🐚", x: 0.4, y: 0.93, s: 40, at: 0.36, loop: "sway" }],
  eight:      [{ t: "drift", e: "🦋", from: -0.1, to: 1.1, y0: 0.22, y1: 0.06, s: 54, at: -0.02, dur: 0.8, loop: "flap" },
               { t: "pop", e: "🏸", x: 0.12, y: 0.9, s: 60, at: 0.08, loop: "swing" }, { t: "pop", e: "🎂", x: 0.3, y: 0.92, s: 48, at: 0.2, loop: "bob" }],
  dayout:     [{ t: "rain" }, { t: "walk", e: "☂️", from: -0.25, to: 0.41, y: 0.8, s: 84, at: 0.05, loop: "sway" },
               { t: "walk", e: B, from: -0.3, to: 0.35, y: 0.95, s: 46, at: 0.05, loop: "hop" }, { t: "walk", e: M, from: -0.35, to: 0.47, y: 0.95, s: 50, at: 0.05, loop: "hop" },
               { t: "pop", e: "🐷", x: 0.88, y: 0.9, s: 54, at: 0.4, loop: "spin" }],
  summer:     [{ t: "rally" }, { t: "pop", e: "🏸", xs: [0.08, 0.92], y: 0.9, s: 58, at: 0.02, loop: "swing" },
               { t: "pop", e: "🧺", x: 0.5, y: 0.93, s: 46, at: 0.3, loop: "bob" }],
  hospital:   [{ t: "vignette" }, { t: "ecg" }, { t: "pop", e: B, x: 0.42, y: 0.92, s: 48, at: 0.12, loop: "bob" },
               { t: "pop", e: M, x: 0.58, y: 0.92, s: 50, at: 0.18, loop: "bob" }, { t: "pop", e: "💗", x: 0.5, y: 0.82, s: 40, at: 0.24, loop: "slowpulse" }],
  varkala:    [{ t: "bg", e: "🌅", x: 0.84, y: 0.86, s: 150, op: 0.4 }, { t: "pop", e: "☕", x: 0.12, y: 0.9, s: 60, at: 0.08, loop: "bob" },
               { t: "pop", e: "🥐", x: 0.3, y: 0.92, s: 46, at: 0.14, loop: "sway" }, { t: "drift", e: "🦅", from: 1.2, to: -0.2, y0: 0.18, y1: 0.06, s: 74, at: 0.28, dur: 0.5 }],
  temple:     [{ t: "pop", e: "🪔", xs: [0.08, 0.22, 0.78, 0.92], y: 0.93, s: 42, at: 0.04, stagger: 0.04, loop: "flicker" },
               { t: "pop", e: "🌺", xs: [0.12, 0.88], y: 0.1, s: 48, at: 0.18, stagger: 0.06, loop: "sway" }, { t: "pop", e: "💜", x: 0.5, y: 0.9, s: 40, at: 0.3, loop: "pulse" }],
  munroe:     [{ t: "drift", e: ["🐇🐒", "🛶"], from: -0.3, to: 1.25, y: 0.84, s: 46, at: -0.04, dur: 0.9, loop: "bob", cls: "boat" },
               { t: "pop", e: "🌿", xs: [0.06, 0.94], ys: [0.1, 0.12], s: 60, at: 0.05, loop: "sway" }],
  kochi:      [{ t: "pop", e: "☕", x: 0.12, y: 0.1, s: 56, at: 0.05, loop: "bob" }, { t: "walk", e: "🛒", from: -0.2, to: 0.55, y: 0.9, s: 62, at: 0.18, dur: 0.2 },
               { t: "pop", e: "🫓", x: 0.5, y: 0.8, s: 40, at: 0.3, loop: "bob" }, { t: "pop", e: "🥙", x: 0.88, y: 0.1, s: 52, at: 0.24, loop: "wiggle" }],
  lately:     [{ t: "pop", e: "🎨", x: 0.12, y: 0.1, s: 56, at: 0.1, loop: "wiggle" }, { t: "pop", e: "🪄", x: 0.88, y: 0.1, s: 56, at: 0.18, loop: "sway" },
               { t: "pop", e: "✨", xs: [0.8, 0.95], ys: [0.04, 0.18], s: 30, at: 0.22, loop: "twinkle" },
               { t: "peek", e: B, x: 0.2, y: 0.9, s: 62, at: 0.2, loop: "hop" }, { t: "peek", e: M, x: 0.8, y: 0.9, s: 66, at: 0.26, loop: "hop" },
               { t: "pop", e: "💼", x: 0.5, y: 0.93, s: 42, at: 0.34, loop: "bob" }],
};
const FX_FULL = new Set(["flash", "vignette"]);
// phones have no free side next to the words: characters & props get a strip under the text,
// and the ambient pieces (lanterns, petals, fog...) use the whole screen
const FX_FULL_PHONE = new Set(["flash", "vignette", "lanterns", "fog", "hotair", "needles", "bees", "holi", "halforbit", "distance", "fall", "rain"]);
const fxFull = (it) => (isPhone() ? FX_FULL_PHONE.has(it.t) || (it.t === "rise" && it.y1 == null) : FX_FULL.has(it.t));
const rnd = (i) => { const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453; return x - Math.floor(x); };
const pct = (v) => (v * 100).toFixed(2) + "%";
// keep the top/bottom rows clear of the HUD (top bar, chapter counter): squeeze the outer bands inward
const Y = (v) => (v < 0 || v > 1 ? v : isPhone() ? (v < 0.5 ? 0.36 : 0.36 + (v - 0.5) * 1.1)
  : v < 0.2 ? 0.1 + v * 0.4 : v > 0.8 ? 0.8 + (v - 0.8) * 0.6 : v);
const fsz = (s) => `calc(${s}px * var(--fxk, 1))`;
const waveD = (amp, len, y) => { let d = `M0 ${y}`; for (let x = 0; x <= 2400; x += len) d += ` q ${len / 4} ${-amp} ${len / 2} 0 t ${len / 2} 0`; return d + ` V 140 H 0 Z`; };
const ARC = { x0: 70, y0: 150, cx: 300, cy: 18, x1: 530, y1: 150 };
const PLANE = "M0 -5 L4 -1 L14 -1 Q17 0 14 1 L4 1 L0 5 L-2 5 L1 1 L-5 1 L-7 3 L-8.5 3 L-7.5 0 L-8.5 -3 L-7 -3 L-5 -1 L1 -1 L-2 -5 Z";
// how many elements an item renders, and where
const fxCount = (it) => it.n || (Array.isArray(it.xs) ? it.xs.length : Array.isArray(it.e) && (it.t === "rise" || it.t === "fall") ? it.e.length : 1);
const fxE = (it, j) => (Array.isArray(it.e) && it.t !== "walk" && it.t !== "drift" ? it.e[j % it.e.length] : it.e);

function Emo({ it, j, k }) {
  const x = it.xs ? it.xs[j] : it.x != null ? it.x : it.t === "fall" || it.t === "rise" ? 0.06 + rnd(k * 7 + j) * 0.88 : it.from != null ? it.from : 0.5;
  const y = it.t === "peek" ? 1.18 : Y(it.ys ? it.ys[j] : it.y != null ? it.y : it.y0 != null ? it.y0 : it.t === "rise" ? 1.12 : it.t === "fall" ? -0.1 : 0.5);
  const s = it.ss ? it.ss[j] : it.s || 48;
  const flip = (it.t === "walk" || it.t === "drift") && it.to > it.from;
  const e = fxE(it, j), lines = Array.isArray(e) ? e : [e];
  return html`<span className=${"fxe" + (it.cls ? " " + it.cls : "")} data-k=${k} style=${{ left: pct(x), top: pct(y), fontSize: fsz(s), opacity: it.t === "bg" ? 0 : undefined }}>
    <span className=${flip ? "fxf" : ""}><b className=${"fxl-" + (it.loop || "none")}>${lines.map((l, i) => html`<i key=${i}>${l}</i>`)}</b></span></span>`;
}

function FxScene({ k, it, left }) {
  switch (it.t) {
    case "waves": return html`<div className="fx-waves" data-k=${k}><svg viewBox="0 0 2400 140" preserveAspectRatio="none">
        <path className="w1" d=${waveD(12, 300, 66)} /><path className="w2" d=${waveD(8, 220, 90)} /></svg></div>`;
    case "lanterns": return html`${[0.16, 0.5, 0.84].map((x, i) => html`<div key=${i} data-k=${k} className=${"fx-lantern l" + i} style=${{ left: pct(x) }}><b><i></i></b></div>`)}`;
    case "flash": return html`<i className="fx-flash" data-k=${k}></i>`;
    case "bolt": return html`<svg className="fx-bolt" data-k=${k} viewBox="0 0 100 220" style=${{ left: pct(left ? 0.72 : 0.12) }}><path pathLength="1" d="M58 0 L36 92 L60 92 L30 220 L52 118 L30 118 L52 0" /></svg>`;
    case "fog": return html`${[0, 1, 2].map((i) => html`<i key=${i} data-k=${k} className=${"fx-fog f" + i}></i>`)}`;
    case "hotair": return html`<svg className="fx-hotair" data-k=${k} viewBox="0 0 100 140" style=${{ left: pct(left ? 0.8 : 0.2) }}>
        <path d="M50 4 C20 4 6 28 6 50 C6 74 34 92 40 104 L60 104 C66 92 94 74 94 50 C94 28 80 4 50 4 Z" fill="#ff8fb1" />
        <path d="M50 4 C38 4 30 28 30 50 C30 74 44 92 46 104 L54 104 C56 92 70 74 70 50 C70 28 62 4 50 4 Z" fill="#f2c27b" />
        <path d="M50 4 C46 4 44 28 44 50 C44 74 48 92 49 104 L51 104 C52 92 56 74 56 50 C56 28 54 4 50 4 Z" fill="#fff4e6" />
        <path d="M41 106 L44 120 M59 106 L56 120" stroke="#f7efe4" stroke-width="1.6" /><rect x="42" y="119" width="16" height="13" rx="2" fill="#a0673d" /></svg>`;
    case "needles": return html`${Array.from({ length: 14 }, (_, i) => html`<i key=${i} data-k=${k} className="fx-needle" style=${{ left: pct(0.04 + rnd(i) * 0.92) }}></i>`)}`;
    case "bees": return html`<div className="fx-bees" data-k=${k}>${[0, 1].map((i) => html`<span key=${i} className=${"fx-bee b" + i}><b>🐝</b></span>`)}</div>`;
    case "holi": return html`${[0, 1, 2, 3].map((i) => html`<i key=${i} data-k=${k} className=${"fx-holi h" + i}></i>`)}`;
    case "distance": return html`<svg className="fx-dist" data-k=${k} viewBox="0 0 600 200" preserveAspectRatio="xMidYMid meet">
        <defs><mask id="fx-dist-m"><path className="fx-dist-m" pathLength="1" d=${`M${ARC.x0} ${ARC.y0} Q${ARC.cx} ${ARC.cy} ${ARC.x1} ${ARC.y1}`} /></mask></defs>
        <path className="fx-dist-p" mask="url(#fx-dist-m)" d=${`M${ARC.x0} ${ARC.y0} Q${ARC.cx} ${ARC.cy} ${ARC.x1} ${ARC.y1}`} />
        <circle cx=${ARC.x0} cy=${ARC.y0} r="6" /><circle cx=${ARC.x1} cy=${ARC.y1} r="6" />
        <text x=${ARC.x0} y=${ARC.y0 + 36} textAnchor="middle">Kolkata</text><text x=${ARC.x1} y=${ARC.y1 + 36} textAnchor="middle">Bangalore</text>
        <path className="fx-plane" d=${PLANE} transform=${`translate(${ARC.x0} ${ARC.y0}) scale(2.6)`} /></svg>`;
    case "halforbit": return html`<svg className="fx-orbit" data-k=${k} viewBox="-110 -110 220 220">
        <circle className="fx-orbit-bg" r="100" /><path className="fx-orbit-arc" pathLength="1" d="M-100 0 A100 100 0 0 1 100 0" /><circle className="fx-orbit-dot" r="5" cx="-100" cy="0" /></svg>`;
    case "rain": return html`<div className="fx-rain" data-k=${k}>${Array.from({ length: 30 }, (_, i) => html`<i key=${i} style=${{ left: pct(rnd(i)), animationDelay: (-rnd(i + 9) * 1.2).toFixed(2) + "s", animationDuration: (0.7 + rnd(i + 19) * 0.4).toFixed(2) + "s" }}></i>`)}</div>`;
    case "rally": return html`<span className="fxe fx-shuttle" data-k=${k} style=${{ fontSize: fsz(40) }}><span><b><i>🏸</i></b></span></span>`;
    case "vignette": return html`<i className="fx-vig" data-k=${k}></i>`;
    case "ecg": return html`<svg className="fx-ecg" data-k=${k} viewBox="0 0 600 80" preserveAspectRatio="none">
        <path className="fx-ecg-base" d="M0 40 H230 L245 40 L253 16 L263 68 L273 4 L283 52 L293 40 H600" />
        <path className="fx-ecg-pulse" pathLength="1" d="M0 40 H230 L245 40 L253 16 L263 68 L273 4 L283 52 L293 40 H600" /></svg>`;
    default: return html`${Array.from({ length: fxCount(it) }, (_, j) => html`<${Emo} key=${j} it=${it} j=${j} k=${k} />`)}`;
  }
}

function FxMarkup({ items, left, full }) {
  return html`${items.map((it, k) => (fxFull(it) === !!full && !(it.t === "bg" && isPhone()) ? html`<${FxScene} key=${k} k=${k} it=${it} left=${left} />` : null))}`;
}

// the motion, placed on the chapter's timeline (a = pinned, b = unpinned, w = b - a)
function fxAnim(items, tl, { a, b, w, root }) {
  if (!root) return;
  const T = (f) => a + w * f;
  items.forEach((it, k) => {
    const els = [...root.querySelectorAll(`[data-k="${k}"]`)];
    if (!els.length) return;
    const at = it.at ?? 0, out = it.out ?? 0.8, st = it.stagger ?? 0.05;
    const popIn = (el, t) => tl.fromTo(el, { xPercent: -50, yPercent: -50, scale: 0, rotate: -25, opacity: 0 },
      { scale: 1, rotate: 0, opacity: 1, duration: w * 0.08, ease: "back.out(2.4)" }, t);
    const popOut = (el, t) => tl.to(el, { scale: 0, opacity: 0, duration: w * 0.06, ease: "back.in(2)" }, t);
    // moves set left/top directly (in % of the scene) so they stay exact at any scroll position
    const mv = (el, A, Bp, dur, ease, t) => {
      const o = { p: 0 }, put = () => {
        if (A.l != null) el.style.left = pct(A.l + (Bp.l - A.l) * o.p);
        if (A.t != null) el.style.top = pct(A.t + (Bp.t - A.t) * o.p);
      };
      tl.fromTo(o, { p: 0 }, { p: 1, duration: dur, ease, onUpdate: put, onStart: put }, t);
    };
    const center = (el) => gsap.set(el, { xPercent: -50, yPercent: -50 });
    switch (it.t) {
      case "pop":
        els.forEach((el, j) => { popIn(el, T(at + j * st)); popOut(el, T(out + j * 0.015)); });
        break;
      case "bg":
        els.forEach((el) => tl.fromTo(el, { xPercent: -50, yPercent: -50, scale: 0.85, opacity: 0 }, { scale: 1, opacity: it.op ?? 0.25, duration: w * 0.2 }, T(at - 0.05))
          .to(el, { opacity: 0, scale: 1.05, duration: w * 0.12 }, T(0.82)));
        break;
      case "peek":
        els.forEach((el) => { center(el); mv(el, { t: 1.18 }, { t: Y(it.y) }, w * 0.09, "back.out(1.7)", T(at)); mv(el, { t: Y(it.y) }, { t: 1.18 }, w * 0.07, "back.in(1.5)", T(out)); });
        break;
      case "walk": {
        const away = it.to > it.from ? 1.25 : -0.25;
        els.forEach((el) => { center(el); mv(el, { l: it.from }, { l: it.to }, w * (it.dur ?? 0.14), "power1.out", T(at)); mv(el, { l: it.to }, { l: away }, w * 0.12, "power1.in", T(out)); });
        break;
      }
      case "drift":
        els.forEach((el) => { center(el); mv(el, { l: it.from, t: Y(it.y0 ?? it.y) }, { l: it.to, t: Y(it.y1 ?? it.y) }, w * (it.dur ?? 0.6), "none", T(at)); });
        break;
      case "rise":
        els.forEach((el, j) => {
          const t0 = T(at + j * (it.stagger ?? 0.08)), d = w * (it.dur ?? 0.7);
          center(el); mv(el, { t: Y(it.y0 ?? 1.12) }, { t: Y(it.y1 ?? -0.15) }, d, "none", t0);
          if (it.y1 != null) tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: d, ease: "power1.in" }, t0);
        });
        break;
      case "fall":
        els.forEach((el, j) => { center(el); mv(el, { t: -0.08 }, { t: 1.08 }, w * (it.dur ?? 0.7) * (0.75 + rnd(j + 40) * 0.5), "none", T(-0.06 + rnd(j + 60) * 0.5)); });
        break;
      case "waves":
        tl.fromTo(els, { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: w * 0.15 }, T(-0.04)).to(els, { yPercent: 100, opacity: 0, duration: w * 0.12 }, T(0.82));
        break;
      case "lanterns":
        els.forEach((el, j) => mv(el, { t: 1.1 }, { t: -0.25 }, w * (0.75 + j * 0.06), "none", T(-0.06 + j * 0.1)));
        break;
      case "flash": {
        const t = T(0.03);
        tl.to(els, { opacity: 0.32, duration: w * 0.01 }, t).to(els, { opacity: 0, duration: w * 0.03 }, t + w * 0.01)
          .to(els, { opacity: 0.2, duration: w * 0.008 }, t + w * 0.05).to(els, { opacity: 0, duration: w * 0.05 }, t + w * 0.058);
        break;
      }
      case "bolt":
        tl.fromTo(els[0].querySelector("path"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: w * 0.02 }, T(0.03))
          .fromTo(els, { opacity: 1 }, { opacity: 0, duration: w * 0.1 }, T(0.1));
        break;
      case "fog":
        els.forEach((f, i) => tl.fromTo(f, { xPercent: i % 2 ? 14 : -14 }, { xPercent: i % 2 ? -14 : 14, duration: 1, ease: "none" }, 0));
        tl.fromTo(els, { opacity: 1 }, { opacity: 0.25, duration: w * 0.45, ease: "power1.inOut" }, T(-0.02)).to(els, { opacity: 0, duration: w * 0.15 }, T(0.8));
        break;
      case "hotair":
        mv(els[0], { t: 1.05 }, { t: -0.3 }, w * 0.95, "none", T(-0.06));
        break;
      case "needles":
        els.forEach((n, i) => { const t0 = T(-0.04 + rnd(i + 50) * 0.55), d = w * (0.42 + rnd(i + 70) * 0.2);
          mv(n, { t: -0.08 }, { t: 1.08 }, d, "none", t0); tl.fromTo(n, { rotate: 0 }, { rotate: rnd(i + 30) * 200 - 100, duration: d, ease: "none" }, t0); });
        break;
      case "bees": case "rain": case "ecg":
        tl.fromTo(els, { opacity: 0 }, { opacity: it.t === "ecg" ? 0.85 : 1, duration: w * 0.1 }, T(-0.02)).to(els, { opacity: 0, duration: w * 0.1 }, T(0.8));
        break;
      case "vignette":
        tl.fromTo(els, { opacity: 0 }, { opacity: 1, duration: w * 0.2 }, T(-0.05)).to(els, { opacity: 0, duration: w * 0.15 }, T(0.84));
        break;
      case "holi":
        els.forEach((h, i) => tl.fromTo(h, { scale: 0.4, opacity: 0 }, { scale: 1.1, opacity: 0.6, duration: w * 0.16, ease: "power2.out" }, T(0.02 + i * 0.1))
          .to(h, { scale: 1.35, opacity: 0, duration: w * 0.24 }, T(0.24 + i * 0.1)));
        break;
      case "distance": {
        const plane = els[0].querySelector(".fx-plane"), o = { p: 0 };
        const put = (p) => {
          const u = 1 - p, x = u * u * ARC.x0 + 2 * u * p * ARC.cx + p * p * ARC.x1, y = u * u * ARC.y0 + 2 * u * p * ARC.cy + p * p * ARC.y1;
          const dx = 2 * u * (ARC.cx - ARC.x0) + 2 * p * (ARC.x1 - ARC.cx), dy = 2 * u * (ARC.cy - ARC.y0) + 2 * p * (ARC.y1 - ARC.cy);
          plane.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}) scale(2.6)`);
        };
        tl.fromTo(els, { opacity: 0 }, { opacity: 1, duration: w * 0.1 }, T(-0.04)).to(els, { opacity: 0, duration: w * 0.1 }, T(0.84))
          .fromTo(els[0].querySelector(".fx-dist-m"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: w * 0.55, ease: "power1.inOut" }, T(0.05))
          .fromTo(o, { p: 0 }, { p: 1, duration: w * 0.55, ease: "power1.inOut", onUpdate: () => put(o.p) }, T(0.05));
        break;
      }
      case "halforbit": {
        const dot = els[0].querySelector(".fx-orbit-dot"), o = { p: 0 };
        tl.fromTo(els, { opacity: 0 }, { opacity: 1, duration: w * 0.1 }, T(-0.04)).to(els, { opacity: 0, duration: w * 0.1 }, T(0.82))
          .fromTo(els[0].querySelector(".fx-orbit-arc"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: w * 0.5, ease: "power1.inOut" }, T(0.02))
          .fromTo(o, { p: 0 }, { p: 1, duration: w * 0.5, ease: "power1.inOut", onUpdate: () => {
            const th = Math.PI * (1 - o.p); dot.setAttribute("cx", (100 * Math.cos(th)).toFixed(2)); dot.setAttribute("cy", (-100 * Math.sin(th)).toFixed(2)); } }, T(0.02));
        break;
      }
      case "rally": {
        const el = els[0], o = { p: 0 };
        const put = (p) => { // two shots across the text side: left -> right, then back
          const leg = p < 0.5 ? p * 2 : (p - 0.5) * 2, dir = p < 0.5 ? 1 : -1;
          const x = dir > 0 ? 0.1 + 0.8 * leg : 0.9 - 0.8 * leg, y = 0.18 - 0.14 * 4 * leg * (1 - leg);
          el.style.left = pct(x); el.style.top = pct(y);
          el.style.transform = `translate(-50%,-50%) rotate(${((leg - 0.5) * 140 * dir + (dir > 0 ? 0 : 180)).toFixed(1)}deg)`;
        };
        tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: w * 0.06 }, T(0.02)).to(el, { opacity: 0, duration: w * 0.06 }, T(0.8))
          .fromTo(o, { p: 0 }, { p: 1, duration: w * 0.72, ease: "none", onUpdate: () => put(o.p) }, T(0.04));
        break;
      }
    }
  });
}

function Chapter({ stop, idx, n }) {
  const ref = useRef();
  const left = n % 2 === 0;
  const fxItems = REDUCED ? null : FXS[stop.key];
  useScrub(ref, (tl, { a, b, w }) => {
    const q = (s) => ref.current.querySelectorAll(s);
    const inA = a - 0.03, inB = a + w * 0.2, outA = a + w * 0.76;
    tl.fromTo(q(".ch-num"), { yPercent: 60 }, { yPercent: -60, duration: 1, ease: "none" }, 0)
      .fromTo(q(".ch-num"), { opacity: 0 }, { opacity: 1, duration: w * 0.25 }, a - 0.06)
      .to(q(".ch-num"), { opacity: 0, duration: w * 0.2 }, outA)
      .fromTo(q(".ch-kicker"), { x: left ? -60 : 60, opacity: 0 }, { x: 0, opacity: 1, duration: inB - inA }, inA)
      .fromTo(q(".ch-title .ch"), { yPercent: 120, rotateX: -85, scaleY: 1.6, opacity: 0 },
        { yPercent: 0, rotateX: 0, scaleY: 1, opacity: 1, duration: (inB - inA) * 0.7, stagger: { amount: (inB - inA) * 0.45 }, ease: "power3.out" }, inA + 0.01)
      .fromTo(q(".ch-date"), { opacity: 0, letterSpacing: "0.7em" }, { opacity: 1, letterSpacing: "0.16em", duration: inB - inA, ease: "power2.out" }, inA + 0.03)
      .fromTo(q(".ch-line .rw"), { opacity: 0.06, y: 14, filter: bl(8) },
        { opacity: 1, y: 0, filter: bl(0), duration: w * 0.07, stagger: { amount: w * 0.16 } }, a + w * 0.02)
      .fromTo(q(".ch-col"), { y: 40 }, { y: -40, duration: b - a }, a)
      .fromTo(q(".ch-rule"), { scaleX: 0 }, { scaleX: 1, duration: w * 0.3, ease: "power2.out" }, a + w * 0.05)
      .to(q(".ch-title .ch"), { yPercent: -120, opacity: 0, rotateX: 60, duration: w * 0.12, stagger: { amount: w * 0.06 }, ease: "power2.in" }, outA)
      .to(q(".ch-meta, .ch-body"), { y: -60, opacity: 0, filter: bl(8), duration: w * 0.15, stagger: w * 0.02 }, outA);
    if (fxItems) { fxAnim(fxItems, tl, { a, b, w, root: ref.current.querySelector(".fx") });
      fxAnim(fxItems, tl, { a, b, w, root: ref.current.querySelector(".fx-full") }); }
  });
  return html`<section className=${"sec sec-ch" + (left ? " left" : " right") + (stop.placeholder ? " is-draft" : "")}
      data-stop=${idx} data-name=${stop.title} data-chime=${n} ref=${ref}>
    <div className="pin">
      ${fxItems && html`<div className="fx-full" aria-hidden="true"><${FxMarkup} items=${fxItems} left=${left} full=${true} /></div>
        <div className=${"fx fx-c-" + stop.key} aria-hidden="true"><${FxMarkup} items=${fxItems} left=${left} /></div>`}
      <div className="ch-num" aria-hidden="true">${String(n + 1).padStart(2, "0")}</div>
      <div className="ch-col">
        <div className="ch-meta">
          <p className="mono ch-kicker">Chapter ${String(n + 1).padStart(2, "0")} <span>✦</span> ${stop.kicker}</p>
        </div>
        <h2 className="ch-title"><${SplitText} text=${stop.title} /></h2>
        <div className="ch-meta"><p className="mono ch-date">${stop.date}</p><i className="ch-rule"></i></div>
        <div className="ch-body">
          ${stop.lines.map((l, i) => html`<p className="ch-line" key=${i}><${RevealWords} text=${l} /></p>`)}
          ${stop.placeholder && html`<p className="mono draft-chip">Photos coming soon</p>`}
        </div>
      </div>
    </div>
  </section>`;
}

function DayOne({ stop, idx }) {
  const ref = useRef();
  useScrub(ref, (tl, { a, b, w }) => {
    const q = (s) => ref.current.querySelectorAll(s);
    tl.fromTo(q(".d1-num"), { scale: 0.4, opacity: 0, filter: bl(30) }, { scale: 1, opacity: 1, filter: bl(0), duration: w * 0.35, ease: "expo.out" }, a - 0.06)
      .to(q(".d1-num"), { scale: 1.12, duration: w * 0.35 }, a + w * 0.3)
      .to(q(".d1-num"), { scale: 4.5, opacity: 0, filter: bl(16), duration: w * 0.26, ease: "power2.in" }, a + w * 0.68)
      .fromTo(q(".d1-day"), { opacity: 0, y: -30 }, { opacity: 1, y: 0, duration: w * 0.2 }, a + w * 0.05)
      .fromTo(q(".d1-date"), { opacity: 0, letterSpacing: "1em" }, { opacity: 1, letterSpacing: "0.3em", duration: w * 0.3 }, a + w * 0.1)
      .fromTo(q(".d1-line .rw"), { opacity: 0, filter: bl(8) }, { opacity: 1, filter: bl(0), duration: w * 0.1, stagger: { amount: w * 0.25 } }, a + w * 0.2)
      .to(q(".d1-day, .d1-date, .d1-line"), { opacity: 0, y: -40, duration: w * 0.2 }, a + w * 0.7);
  });
  return html`<section className="sec sec-d1" data-stop=${idx} data-name="Day one" ref=${ref}>
    <div className="pin center">
      <div className="d1">
        <p className="mono d1-day">Day</p>
        <div className="d1-num">1</div>
        <p className="mono d1-date">${stop.date}</p>
        <p className="d1-line"><${RevealWords} text=${stop.line} /></p>
      </div>
    </div>
  </section>`;
}

function Marquee({ rows }) {
  const ref = useRef();
  useEffect(() => {
    const tracks = [...ref.current.querySelectorAll(".mq-track")];
    let x = tracks.map(() => 0), visible = false, skew = 0;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(ref.current);
    const tick = (t, dt) => {
      if (!visible) return;
      const v = app.lenis ? app.lenis.velocity : 0;
      skew += (clamp(v * 0.25, -10, 10) - skew) * 0.1;
      tracks.forEach((tr, i) => {
        const dir = i % 2 ? 1 : -1, wd = tr.firstChild.offsetWidth || 1;
        x[i] += dir * (0.04 * dt + Math.abs(v) * 0.35) * (i % 2 ? 0.8 : 1);
        x[i] = ((x[i] % wd) + wd) % wd;
        tr.style.transform = `translate3d(${-x[i]}px,0,0) skewX(${-skew * dir}deg)`;
      });
    };
    gsap.ticker.add(tick);
    return () => { gsap.ticker.remove(tick); io.disconnect(); };
  }, []);
  return html`<section className="sec sec-mq" ref=${ref} aria-hidden="true">
    ${rows.map((r, i) => html`<div className=${"mq" + (i % 2 ? " alt" : "")} key=${i}>
      <div className="mq-track">${[0, 1, 2].map((k) => html`<span key=${k}>${r} ${r} </span>`)}</div>
    </div>`)}
  </section>`;
}

/* ================================================================
   Time flies: the corridor between two scenes. The photos themselves are in
   the 3D sky (cosmos.js); this section gives the scroll room and shows the date
   of the photo drifting past, so you watch time move from one event to the next.
   ================================================================ */
function Lane({ stop, idx }) {
  const n = stop.media.length;
  return html`<section className="sec sec-lane" data-lane-key=${stop.key}
      style=${{ height: `calc(${n} * var(--lane-step) + 100vh)` }} aria-label=${"Moments between " + stop.fromTitle + " and " + stop.toTitle}>
    <div className="lane-pin">
      <div className="lane-in">
        <p className="mono lane-k">Time flies <span>✦</span> ${stop.fromTitle} → ${stop.toTitle}</p>
        <p className="lane-date" data-ld>${stop.dateFrom}</p>
        <p className="lane-time mono" data-lt> </p>
        <p className="lane-cap" data-lc></p>
        <p className="mono lane-hint">${FINE ? "click" : "tap"} a photo to open it</p>
        <i className="lane-bar"><b data-lb></b></i>
      </div>
    </div>
    <div className="lane-fallback">${stop.media.map((id) => html`<img key=${id} src=${"assets/md/" + id + ".jpg"} loading="lazy" alt="" />`)}</div>
    <div className="lane-mark a" data-stop=${idx} data-lane="1" data-name=${"→ " + stop.toTitle}></div>
    <div className="lane-mark b" data-stop=${idx + 1} data-lane="1" data-name=${"→ " + stop.toTitle}></div>
  </section>`;
}

const capOf = (stop, id) => ((stop.hero || []).find((h) => h.id === id) || {}).cap || "";

/* full-screen viewer for any flying photo: swipe / arrows, Back returns to the story */
function Viewer({ view, onNav, onClose }) {
  const { stop, i } = view;
  const items = stop.media;
  const id = items[i], m = MEDIA[id] || {};
  const cap = capOf(stop, id);
  const tx = useRef(null);
  useEffect(() => {
    app.lenis && app.lenis.stop();
    document.documentElement.classList.add("vw-open");
    return () => { app.lenis && app.lenis.start(); document.documentElement.classList.remove("vw-open"); };
  }, []);
  useEffect(() => {
    if (m.v) sound.duck(true);
    // warm up the neighbours
    [i - 1, i + 1].forEach((k) => { const nid = items[k]; if (nid && !(MEDIA[nid] || {}).v) { const im = new Image(); im.src = "assets/photos/" + nid + ".jpg"; } });
    return () => { if (m.v) sound.duck(false); };
  }, [id]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "ArrowRight") onNav(1);
      else if (e.key === "ArrowLeft") onNav(-1);
      else if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onNav, onClose]);
  const ts = (e) => { const t = e.touches[0]; tx.current = [t.clientX, t.clientY]; };
  const te = (e) => {
    if (!tx.current) return;
    const t = e.changedTouches[0], dx = t.clientX - tx.current[0], dy = t.clientY - tx.current[1];
    tx.current = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) onNav(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
  };
  return html`<div className="vw" role="dialog" aria-modal="true" aria-label=${stop.title} data-lenis-prevent>
    <div className="vw-top">
      <button type="button" className="vw-back" onClick=${onClose} data-hover>← Back to the story</button>
      <span className="mono vw-ttl"><b>${stop.title}</b> · ${i + 1} / ${items.length}</span>
    </div>
    <div className="vw-stage" onTouchStart=${ts} onTouchEnd=${te}>
      ${m.v
        ? html`<video key=${id} src=${"assets/video/" + id + ".mp4"} poster=${"assets/md/" + id + ".jpg"} controls autoplay playsinline></video>`
        : html`<img key=${id} src=${"assets/photos/" + id + ".jpg"} alt=${cap || m.t || ""} />`}
      ${items.length > 1 && html`<button type="button" className="vw-nav l" onClick=${() => onNav(-1)} aria-label="Previous" data-hover>‹</button>`}
      ${items.length > 1 && html`<button type="button" className="vw-nav r" onClick=${() => onNav(1)} aria-label="Next" data-hover>›</button>`}
    </div>
    <div className="vw-cap">
      ${cap ? html`<p>${cap}</p>` : null}
      <small className="mono">${m.t || ""}</small>
    </div>
  </div>`;
}

function Stats({ stop, idx }) {
  const ref = useRef();
  const resolve = (v) => (v === "days" ? DAYS : v === "photos" ? PHOTO_COUNT : v);
  useScrub(ref, (tl, { a, w }) => {
    const q = (s) => ref.current.querySelectorAll(s);
    tl.fromTo(q(".st-h .ch"), { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: w * 0.18, stagger: { amount: w * 0.1 } }, a - 0.03)
      .fromTo(q(".st-row"), { opacity: 0, x: (i) => (i % 2 ? 40 : -40) }, { opacity: 1, x: 0, duration: w * 0.15, stagger: w * 0.045 }, a + w * 0.05);
    q(".st-v").forEach((el) => {
      if (el.dataset.v === "") return;
      const target = Number(el.dataset.v);
      const o = { v: 0 };
      tl.to(o, { v: target, duration: w * 0.4, ease: "power2.out", onUpdate: () => (el.textContent = Math.round(o.v).toLocaleString()) }, a + w * 0.08);
    });
    tl.to(q(".st-h, .st-row"), { opacity: 0, y: -40, filter: bl(8), duration: w * 0.16, stagger: w * 0.012 }, a + w * 0.68);
  });
  return html`<section className="sec sec-st" data-stop=${idx} data-name="By the numbers" ref=${ref}>
    <div className="pin center">
      <div className="st">
        <h2 className="st-h"><${SplitText} text="One year, counted" /></h2>
        <dl className="st-grid">
          ${stop.rows.map((r, i) => {
            const v = resolve(r.value);
            return html`<div className="st-row" key=${i}><dt className="mono">${r.label}</dt>
              <dd><span className="st-v" data-v=${typeof v === "number" ? v : ""}>${typeof v === "number" ? v.toLocaleString() : v}</span>${r.suffix && html`<small>${r.suffix}</small>`}</dd></div>`;
          })}
        </dl>
      </div>
    </div>
  </section>`;
}

function Letter({ stop, idx }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    const ctx = gsap.context(() => {
      el.querySelectorAll(".lt-p").forEach((p) => {
        gsap.fromTo(p.querySelectorAll(".rw"), { opacity: 0.08, filter: bl(6), y: 8 },
          { opacity: 1, filter: bl(0), y: 0, stagger: 0.04, ease: "none",
            scrollTrigger: { trigger: p, start: "top 90%", end: "bottom 68%", scrub: 0.5 } });
      });
      gsap.fromTo(el.querySelectorAll(".lt-k, .lt-hi"), { opacity: 0, y: 30 }, {
        opacity: 1, y: 0, stagger: 0.2, duration: 1.2, ease: "power3.out",
        scrollTrigger: { trigger: el.querySelector(".lt"), start: "top 75%", toggleActions: "play none none reverse" }
      });
      gsap.fromTo(el.querySelector(".lt-sign"), { opacity: 0, y: 30 }, {
        opacity: 1, y: 0, duration: 1.4, ease: "power3.out",
        scrollTrigger: { trigger: el.querySelector(".lt-sign"), start: "top 85%", toggleActions: "play none none reverse" }
      });
    }, el);
    return () => ctx.revert();
  }, []);
  return html`<section className="sec sec-lt" data-stop=${idx} data-name="A letter" ref=${ref}>
    <article className="lt">
      <p className="mono lt-k">Unsent until today</p>
      <p className="lt-hi">${stop.greeting}</p>
      ${stop.paragraphs.map((p, i) => html`<p className="lt-p" key=${i}><${RevealWords} text=${p} /></p>`)}
      <p className="lt-sign">— ${stop.signoff}</p>
    </article>
  </section>`;
}

function Question({ stop, idx, onYes, won }) {
  const ref = useRef(), noRef = useRef(), yesRef = useRef();
  const [taunt, setTaunt] = useState("");
  const st = useRef({ dodges: 0, fixed: false, gave: false, yesScale: 1 });
  const wonRef = useRef(won); wonRef.current = won;
  const [gave, setGave] = useState(false);

  useScrub(ref, (tl, { a, w }) => {
    const q = (s) => ref.current.querySelectorAll(s);
    tl.fromTo(q(".q-title .ch"), { yPercent: 120, opacity: 0, rotateX: -80 }, { yPercent: 0, opacity: 1, rotateX: 0, duration: w * 0.2, stagger: { amount: w * 0.12 }, ease: "power3.out" }, a - 0.04)
      .fromTo(q(".q-sub"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: w * 0.15 }, a + w * 0.12)
      .fromTo(q(".q-btns"), { opacity: 0 }, { opacity: 1, duration: w * 0.15 }, a + w * 0.2);
  });

  const reset = () => {
    const b = noRef.current; if (!b) return;
    Object.assign(st.current, { dodges: 0, fixed: false, gave: false, yesScale: 1 });
    gsap.killTweensOf([b, yesRef.current]);
    gsap.set(b, { clearProps: "all" }); b.classList.remove("free");
    gsap.set(yesRef.current, { scale: 1 });
    setGave(false); setTaunt("");
  };
  useEffect(() => {
    const t = ScrollTrigger.create({ trigger: ref.current, start: "top 40%", onLeaveBack: reset });
    app.resetNo = reset;
    return () => t.kill();
  }, []);

  const flee = (px, py) => {
    const s = st.current, b = noRef.current;
    if (s.gave || !b || wonRef.current) return;
    if (!s.fixed) {
      const r = b.getBoundingClientRect();
      b.classList.add("free");
      gsap.set(b, { position: "fixed", left: r.left, top: r.top, margin: 0, zIndex: 60 });
      s.fixed = true;
    }
    const r = b.getBoundingClientRect(), yr = yesRef.current.getBoundingClientRect();
    const pad = 16, top = 70, W = innerWidth, H = innerHeight;
    let best = null, bestD = -1;
    for (let i = 0; i < 40; i++) {
      const x = rand(pad, W - r.width - pad), y = rand(top, H - r.height - pad);
      const cx = x + r.width / 2, cy = y + r.height / 2;
      if (cx > yr.left - 60 && cx < yr.right + 60 && cy > yr.top - 40 && cy < yr.bottom + 40) continue;
      const d = Math.hypot(cx - px, cy - py) + rand(0, 80);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    if (best) gsap.to(b, { left: best[0], top: best[1], rotation: rand(-14, 14), duration: 0.38, ease: "back.out(2)" });
    s.dodges++;
    sound.pluck();
    setTaunt(stop.taunts[(s.dodges - 1) % stop.taunts.length]);
    s.yesScale = Math.min(s.yesScale + 0.08, innerWidth < 600 ? 1.45 : 1.8);
    gsap.to(yesRef.current, { scale: s.yesScale, duration: 0.5, ease: "elastic.out(1, 0.5)" });
    gsap.to(b, { scale: Math.max(0.45, 1 - s.dodges * 0.06), duration: 0.3 });
    if (s.dodges >= stop.taunts.length) {
      s.gave = true; setGave(true);
      gsap.to(b, { rotation: 0, scale: 1, duration: 0.5, ease: "back.out(2)" });
    }
  };
  useEffect(() => {
    if (!FINE) return;
    const mv = (e) => {
      const b = noRef.current; if (!b || st.current.gave || wonRef.current) return;
      if (!st.current.fixed && +gsap.getProperty(b.parentNode, "opacity") < 0.6) return;
      const r = b.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      if (Math.hypot(r.left + r.width / 2 - e.clientX, r.top + r.height / 2 - e.clientY) < 90 + r.width / 2) flee(e.clientX, e.clientY);
    };
    addEventListener("pointermove", mv, { passive: true });
    return () => removeEventListener("pointermove", mv);
  }, []);

  const noDown = (e) => { if (st.current.gave) return; e.preventDefault(); st.current.last = Date.now(); flee(e.clientX, e.clientY); };
  const noClick = (e) => {
    e.preventDefault();
    if (st.current.gave) return onYes(e);
    if (Date.now() - (st.current.last || 0) < 400) return;
    const r = noRef.current.getBoundingClientRect(); flee(r.left + r.width / 2, r.top + r.height / 2);
  };

  return html`<section className="sec sec-q" data-stop=${idx} data-name="Year two" ref=${ref}>
    <div className="pin center">
      <div className=${"q" + (won ? " is-won" : "")}>
        <div className="q-top">
          <p className="mono q-k">Final question</p>
          <h2 className="q-title"><${SplitText} text=${stop.title} /></h2>
          <p className="q-sub">${stop.sub}</p>
        </div>
        <div className="q-top">
        <div className="q-btns">
          <button type="button" id="yes-btn" className="btn btn-yes" ref=${yesRef} onClick=${onYes} data-hover>${stop.yes}</button>
          <button type="button" id="no-btn" className=${"btn btn-no" + (gave ? " gave" : "")} ref=${noRef}
            onPointerDown=${noDown} onClick=${noClick} onPointerEnter=${(e) => FINE && noDown(e)} data-hover>${gave ? "Okay, yes ♥" : stop.no}</button>
        </div>
        <p className="q-taunt" aria-live="polite">${taunt}</p>
        </div>
      </div>
    </div>
  </section>`;
}

function Celebration({ stop, onReplay }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    const tl = gsap.timeline();
    tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1 })
      .fromTo(el.querySelectorAll(".cb-title .ch"), { yPercent: 120, opacity: 0, filter: bl(12) }, { yPercent: 0, opacity: 1, filter: bl(0), duration: 1.6, stagger: 0.04, ease: "expo.out" }, 0.6)
      .fromTo(el.querySelectorAll(".cb-sub, .cb-meta, .cb-strip, .cb-btn"), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 1.2, stagger: 0.25, ease: "power3.out" }, 1.6);
    return () => tl.kill();
  }, []);
  const strip = stop.strip || [];
  return html`<div className="cb" ref=${ref} data-lenis-prevent role="dialog" aria-label="Year two unlocked">
    <div className="cb-in">
      <p className="mono cb-meta">26 · 10 · 2026 <span>✦</span> ${DAYS} days and counting</p>
      <h2 className="cb-title"><${SplitText} text=${stop.won} /></h2>
      <p className="cb-sub">${stop.wonSub}</p>
      <div className="cb-strip">${strip.map((f, i) => html`<img key=${i} src=${"assets/photos/" + f} alt="" style=${{ "--r": `${(i - 2.5) * 4}deg` }} />`)}</div>
      <button type="button" className="btn btn-ghost cb-btn" onClick=${onReplay} data-hover>↺ Fly back through our year</button>
    </div>
  </div>`;
}

/* ================================================================
   HUD, cursor, gate
   ================================================================ */
/* ================================================================
   PLAYER: one shape that morphs between island, toast and player.
   - every size, radius and colour is a spring; content swaps with a short blur,
     the outgoing layer leaves first and the incoming one enters ~90 ms later
   - springs are closed-form (damped step response with initial velocity);
     a new target starts a new segment from the current value and velocity
   - drags are direct manipulation; on release the value springs from wherever it was
   ================================================================ */
const BEAT = CFG.beat || { bpm: 90, offset: 0.25 };
class Spring {
  constructor(v, w = 20, z = 0.86) { this.w = w; this.z = z; this.from = this.to = v; this.v0 = 0; this.t0 = 0; }
  at(t) {
    const { w, z } = this, dt = Math.max(0, t - this.t0), A = this.from - this.to;
    if (A === 0 && this.v0 === 0) return [this.to, 0];
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z), B = (this.v0 + z * w * A) / wd;
      const e = Math.exp(-z * w * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
      return [this.to + e * (A * c + B * s), e * ((B * wd - z * w * A) * c - (A * wd + z * w * B) * s)];
    }
    const B = this.v0 + w * A, e = Math.exp(-w * dt);
    return [this.to + e * (A + B * dt), e * (B - w * (A + B * dt))];
  }
  val(t) { return this.at(t)[0]; }
  go(to, t, w, z) { const [x, v] = this.at(t); this.from = x; this.v0 = v; this.to = to; this.t0 = t; if (w) this.w = w; if (z) this.z = z; return this; }
  // a drag let go at value x moving at speed v: spring from exactly there
  release(x, v, to, t) { this.from = x; this.v0 = v; this.to = to; this.t0 = t; return this; }
}
const now = () => performance.now() / 1000;
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
// play/pause icon: two quads that morph between two bars and a triangle split down the middle
const PP = {
  pause: [[6, 5, 10, 5, 10, 19, 6, 19], [14, 5, 18, 5, 18, 19, 14, 19]],
  play: [[7, 4.5, 12.5, 8, 12.5, 16, 7, 19.5], [12.5, 8, 19, 12, 19, 12, 12.5, 16]],
};
const ppPts = (k, i) => PP.pause[i].map((p, j) => +(p + (PP.play[i][j] - p) * k).toFixed(2)).reduce((s, v, j) => s + (j % 2 ? "," : j ? " " : "") + v, "");

// static first frame (React never touches the points again; the ticker morphs them)
const PP0 = PP.pause[0].join(" "), PP1 = PP.pause[1].join(" ");
function Player({ soundOn, onSound }) {
  const ref = useRef(), S = useRef(null);
  const [open, setOpen] = useState(false);
  const [tab, setTabS] = useState("now");
  const [title, setTitle] = useState(() => { const t = (CFG.songs && CFG.songs[0]) || { title: CFG.songTitle }; return t.title || ""; });
  const [name, artist] = String(title).split(" · ");
  const soundRef = useRef(soundOn); soundRef.current = soundOn;

  useEffect(() => {
    const el = ref.current, q = (s) => el.querySelector(s);
    const L = { island: q(".pl-isl"), toast: q(".pl-toast"), open: q(".pl-open"), now: q(".pl-now"), next: q(".pl-next") };
    const t0 = now();
    const s = (S.current = {
      mode: "island", tab: "now",
      W: new Spring(184), H: new Spring(40), R: new Spring(20), C: new Spring(0),
      p: { island: new Spring(1), toast: new Spring(0), open: new Spring(0), now: new Spring(1), next: new Spring(0) },
      pp: new Spring(soundRef.current ? 0 : 1, 24, 0.9), play: new Spring(soundRef.current ? 1 : 0, 10, 1),
      press: new Spring(0, 26, 0.9), stretch: new Spring(0, 24, 0.82),
      il: new Spring(0, 30, 0.9), ir: new Spring(0, 30, 0.9),
      drag: null, vol: sound.vol ?? 1, prog: 0, lastT: 0, started: false, toastUntil: 0, lastTitle: null,
    });
    const dims = () => {
      const phone = innerWidth < 761;
      const w0 = phone ? 150 : 184, wo = Math.min(340, innerWidth - 32);
      return { w0, wo, toastW: Math.min(296, innerWidth - 32),
        island: [w0, 40, 20], toast: [Math.min(296, innerWidth - 32), 56, 28], now: [wo, 204, 26], next: [wo, 186, 26] };
    };
    let D = dims();
    const applyDims = (t) => {
      const k = s.mode === "open" ? s.tab : s.mode, [w, h, r] = D[k];
      s.W.go(w, t, 19, 0.86); s.H.go(h, t, 19, 0.86); s.R.go(r, t, 22, 0.9); s.C.go(s.mode === "island" ? 0 : 1, t, 14, 1);
    };
    const swap = (group, on, t) => group.forEach((k) => (k === on ? s.p[k].go(1, t + 0.09, 22, 0.92) : s.p[k].go(0, t, 40, 1)));
    s.setMode = (m) => {
      if (m === s.mode) return; const t = now();
      s.mode = m; swap(["island", "toast", "open"], m, t); applyDims(t);
      setOpen(m === "open");
      if (m === "open") s.placeInd(true); // layout exists even while hidden, so measure right away
    };
    s.setTab = (k) => {
      if (k === s.tab) return; const t = now(), dir = k === "next" ? 1 : -1;
      s.tab = k; swap(["now", "next"], k, t); applyDims(t); setTabS(k);
      s.placeInd(false, dir);
    };
    s.placeInd = (instant, dir = 1) => {
      const b = el.querySelector(`.pl-tab[data-k="${s.tab}"]`); if (!b) return;
      const l = b.offsetLeft, r = l + b.offsetWidth, t = now();
      if (instant) { s.il.release(l, 0, l, t); s.ir.release(r, 0, r, t); return; }
      // the leading edge runs ahead, the trailing edge catches up: a liquid stretch
      const fast = 34, slow = 15;
      s.il.go(l, t, dir < 0 ? fast : slow, 0.9); s.ir.go(r, t, dir > 0 ? fast : slow, 0.9);
    };
    s.toast = () => { if (s.mode === "island") { s.setMode("toast"); s.toastUntil = now() + 3.2; } };
    const onResize = () => { D = dims(); document.documentElement.style.setProperty("--isl-w", D.w0 + "px"); applyDims(now()); s.placeInd && s.placeInd(true); };
    onResize(); addEventListener("resize", onResize);
    // the island starts at its size with no animation
    { const [w, h, r] = D.island; s.W.release(w, 0, w, t0); s.H.release(h, 0, h, t0); s.R.release(r, 0, r, t0); }

    const outside = (e) => { if (s.mode === "open" && !el.contains(e.target)) s.setMode("island"); };
    const key = (e) => { if (e.key === "Escape" && s.mode === "open") s.setMode("island"); };
    addEventListener("pointerdown", outside, true); addEventListener("keydown", key);

    const bars = [...el.querySelectorAll(".pl-eq i")];
    const fill = q(".pl-prog-f"), knob = q(".pl-knob"), track = q(".pl-prog-tr"), cur = q(".pl-cur"), rem = q(".pl-rem");
    const vtr = q(".pl-vol-tr"), vfill = q(".pl-vol-f"), ind = q(".pl-ind"), polys = [...el.querySelectorAll(".pl-pp polygon")];
    let lastPP = -1, lastSec = -1, lastRem = -1;
    const layer = (n, p, active) => {
      p = clamp(p, 0, 1.02);
      n.style.opacity = Math.pow(clamp(p, 0, 1), 1.4).toFixed(3);
      n.style.filter = p > 0.995 || REDUCED ? "none" : `blur(${((1 - clamp(p, 0, 1)) * 6).toFixed(2)}px)`;
      n.style.transform = `translateY(${((1 - p) * 4).toFixed(2)}px) scale(${(0.985 + 0.015 * p).toFixed(4)})`;
      n.style.visibility = p < 0.01 ? "hidden" : "visible";
      n.style.pointerEvents = active ? "auto" : "none";
    };
    const tick = () => {
      const t = now(), a = sound.el, dur = a && a.duration > 0 ? a.duration : 0, ct = a ? a.currentTime : 0;
      const playing = !!(sound.started && soundRef.current && a && !a.paused);
      // toast: when the music first starts, when it loops, and when the song changes
      const tr = sound.tracks && sound.tracks[sound.cur];
      if (tr && tr.title !== s.lastTitle) { if (s.lastTitle !== null) s.toast(); s.lastTitle = tr.title; setTitle(tr.title || ""); }
      if (playing && !s.started && ct > 0.05) { s.started = true; s.toast(); }
      if (dur && s.lastT > dur - 2 && ct < 2) s.toast();
      s.lastT = ct;
      if (s.mode === "toast" && t > s.toastUntil) s.setMode("island");
      // play state
      const want = soundRef.current ? 0 : 1;
      if (s.pp.to !== want) s.pp.go(want, t);
      if (s.play.to !== (playing ? 1 : 0)) s.play.go(playing ? 1 : 0, t);
      // shape
      const W = s.W.val(t), H = s.H.val(t), R = s.R.val(t), C = clamp(s.C.val(t), 0, 1);
      const ph = ((ct - BEAT.offset) * BEAT.bpm) / 60, beat = Math.floor(ph), env = Math.exp(-(ph - beat) * 4.5) * s.play.val(t);
      const pIsl = s.p.island.val(t);
      el.style.width = W.toFixed(2) + "px"; el.style.height = H.toFixed(2) + "px"; el.style.borderRadius = R.toFixed(2) + "px";
      const g = Math.round(12 + 5 * C);
      el.style.background = `rgb(${g},${g - 1},${g + 6})`;
      el.style.transform = `scale(${(1 + 0.014 * env * clamp(pIsl, 0, 1)).toFixed(4)})`; // the island breathes on Khat's beat
      layer(L.island, pIsl, s.mode === "island"); layer(L.toast, s.p.toast.val(t), s.mode === "toast"); layer(L.open, s.p.open.val(t), s.mode === "open");
      layer(L.now, s.p.now.val(t), s.mode === "open" && s.tab === "now"); layer(L.next, s.p.next.val(t), s.mode === "open" && s.tab === "next");
      // equaliser: four bars kick on every beat, accented on the bar's downbeat
      const accent = beat % 4 === 0 ? 1 : 0.72;
      bars.forEach((b, i) => {
        const shape = [0.55, 1, 0.72, 0.88][i % 4] * (0.7 + 0.3 * Math.sin(beat * 1.7 + i * 2.1));
        b.style.transform = `scaleY(${(0.25 + 0.75 * clamp(env * shape * accent + 0.12 * s.play.val(t), 0, 1)).toFixed(3)})`;
      });
      // play/pause morph
      const k = clamp(s.pp.val(t), -0.05, 1.05);
      if (Math.abs(k - lastPP) > 0.002) { lastPP = k; polys[0].setAttribute("points", ppPts(k, 0)); polys[1].setAttribute("points", ppPts(k, 1)); }
      // progress (direct manipulation while dragging)
      const pr = s.drag && s.drag.kind === "prog" ? s.drag.v : dur ? ct / dur : 0;
      const pz = clamp(s.press.val(t), 0, 1.1);
      track.style.height = (4 + 6 * pz).toFixed(2) + "px";
      fill.style.transform = `scaleX(${clamp(pr, 0, 1).toFixed(4)})`;
      knob.style.left = (clamp(pr, 0, 1) * 100).toFixed(3) + "%";
      knob.style.transform = `translate(-50%,-50%) scale(${clamp(pz, 0, 1).toFixed(3)})`;
      const sec = Math.floor(pr * dur), rs = Math.floor(dur - pr * dur);
      if (sec !== lastSec) { lastSec = sec; cur.textContent = fmt(sec); }
      if (rs !== lastRem) { lastRem = rs; rem.textContent = dur ? "-" + fmt(rs) : "--:--"; }
      // volume, with a rubber-band stretch past either end
      const st = s.drag && s.drag.kind === "vol" ? s.drag.px : s.stretch.val(t);
      vtr.style.transform = `translateX(${Math.min(0, st).toFixed(2)}px)`;
      vtr.style.width = `calc(100% + ${Math.abs(st).toFixed(2)}px)`;
      vtr.style.height = (4 - Math.min(1.2, Math.abs(st) / 10)).toFixed(2) + "px";
      vfill.style.transform = `scaleX(${s.vol.toFixed(4)})`;
      // tab indicator: its two edges ride different springs
      const il = s.il.val(t), ir = s.ir.val(t);
      ind.style.transform = `translateX(${il.toFixed(2)}px)`; ind.style.width = Math.max(8, ir - il).toFixed(2) + "px";
    };
    gsap.ticker.add(tick);

    // drags: progress and volume
    const startDrag = (kind, e) => {
      const tEl = kind === "prog" ? q(".pl-prog") : q(".pl-vol-hit");
      const rect = (kind === "prog" ? track : q(".pl-vol-bed")).getBoundingClientRect();
      try { tEl.setPointerCapture(e.pointerId); } catch (er) {}
      s.drag = { kind, rect, v: 0, px: 0, lastX: e.clientX, lastT: now(), vel: 0, seekAt: 0 };
      if (kind === "prog") s.press.go(1, now());
      move(e);
      const mv = (ev) => move(ev), up = (ev) => { move(ev); end(); tEl.removeEventListener("pointermove", mv); tEl.removeEventListener("pointerup", up); tEl.removeEventListener("pointercancel", up); };
      tEl.addEventListener("pointermove", mv); tEl.addEventListener("pointerup", up); tEl.addEventListener("pointercancel", up);
    };
    const move = (e) => {
      const d = s.drag; if (!d) return;
      const raw = (e.clientX - d.rect.left) / d.rect.width, t = now();
      if (d.kind === "prog") {
        d.v = clamp(raw, 0, 1);
        const a = sound.el;
        if (a && a.duration > 0 && t - d.seekAt > 0.12) { d.seekAt = t; try { a.currentTime = d.v * a.duration; } catch (er) {} }
      } else {
        s.vol = clamp(raw, 0, 1); sound.setVolume && sound.setVolume(s.vol);
        const over = raw > 1 ? (raw - 1) * d.rect.width : raw < 0 ? raw * d.rect.width : 0;
        const px = Math.sign(over) * 12 * (1 - 1 / (1 + Math.abs(over) / 30)); // resistance grows the further you pull
        const dt = Math.max(1e-3, t - d.lastT); d.vel = (px - d.px) / dt; d.px = px; d.lastT = t;
      }
    };
    const end = () => {
      const d = s.drag; if (!d) return; const t = now();
      if (d.kind === "prog") { const a = sound.el; if (a && a.duration > 0) { try { a.currentTime = d.v * a.duration; } catch (er) {} } s.press.go(0, t); }
      else s.stretch.release(d.px, clamp(d.vel, -400, 400), 0, t);
      s.drag = null;
    };
    s.startDrag = startDrag;
    return () => { gsap.ticker.remove(tick); removeEventListener("resize", onResize); removeEventListener("pointerdown", outside, true); removeEventListener("keydown", key); };
  }, []);

  const eq = html`<span className="pl-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  const icon = (d) => html`<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return html`<div className="pl" ref=${ref} data-lenis-prevent>
    <button type="button" className="pl-isl" onClick=${() => S.current && S.current.setMode("open")}
      aria-label=${"Open music player, now playing " + title} aria-expanded=${open} data-hover>
      ${eq}<span className="pl-isl-t"><b>${name}</b>${artist ? html`<span> · ${artist}</span>` : null}</span>
    </button>
    <button type="button" className="pl-toast" aria-live="polite" onClick=${() => S.current && S.current.setMode("open")} data-hover>
      ${eq}<span className="pl-toast-t"><small>Now playing</small><b>${name}</b>${artist ? html`<span>${artist}</span>` : null}</span>
    </button>
    <div className="pl-open" role="dialog" aria-label="Music player">
      <div className="pl-head">
        <div className="pl-tabs" role="tablist">
          <i className="pl-ind" aria-hidden="true"></i>
          <button type="button" role="tab" className="pl-tab" data-k="now" aria-selected=${tab === "now"} onClick=${() => S.current.setTab("now")} data-hover>Now</button>
          <button type="button" role="tab" className="pl-tab" data-k="next" aria-selected=${tab === "next"} onClick=${() => S.current.setTab("next")} data-hover>Up next</button>
        </div>
        <button type="button" className="pl-x" aria-label="Close player" onClick=${() => S.current.setMode("island")} data-hover>
          ${icon(html`<path d="M6 9l6 6 6-6" />`)}
        </button>
      </div>
      <div className="pl-now">
        <div className="pl-row1">
          <div className="pl-meta"><b>${name}</b><span>${artist || ""}</span></div>
          <button type="button" className="pl-pp" aria-label=${soundOn ? "Pause music" : "Play music"} onClick=${onSound} data-hover>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><polygon points=${PP0} /><polygon points=${PP1} /></svg>
          </button>
        </div>
        <div className="pl-prog" role="slider" aria-label="Song position" tabIndex="0" onPointerDown=${(e) => S.current.startDrag("prog", e)}>
          <div className="pl-prog-tr"><i className="pl-prog-f"></i></div><b className="pl-knob"></b>
        </div>
        <div className="pl-times"><span className="pl-cur">0:00</span><span className="pl-rem">--:--</span></div>
        <div className="pl-vol">
          ${icon(html`<path d="M4 10v4h3l4 3.5v-11L7 10H4z" /><path d="M15.5 9.5a3.5 3.5 0 010 5" /><path d="M18 7a7 7 0 010 10" />`)}
          <div className="pl-vol-hit" role="slider" aria-label="Volume" tabIndex="0" onPointerDown=${(e) => S.current.startDrag("vol", e)}>
            <div className="pl-vol-bed"><div className="pl-vol-tr"><i className="pl-vol-f"></i></div></div>
          </div>
        </div>
      </div>
      <div className="pl-next">
        <p className="pl-cap">Up next</p>
        <div className="pl-item">
          <span className="pl-num">1</span>
          <span className="pl-item-t"><b>${name}</b><span>${artist || ""}</span></span>
          <span className="pl-rep">${icon(html`<path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 014-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 01-4 4H4" />`)}On repeat</span>
        </div>
        <p className="pl-foot">Plays on a loop through the whole story.</p>
      </div>
    </div>
  </div>`;
}

function Hud({ soundOn, onSound, hudRef, onFF, ff }) {
  return html`<div className="hud" ref=${hudRef}>
    <div className="hud-bar-top"><i></i></div>
    <div className="hud-logo mono">C <span>✦</span> A</div>
    <div className="hud-pill">
      <span className="mono hud-day">Day ${DAYS}</span>
      <button type="button" className=${"ffb" + (ff ? " on" : "")} onClick=${onFF} disabled=${ff}
        aria-label="Fast-forward to the end and back, silently" title="Fast-forward to the end and back (silent)" data-hover>
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 5.5v13l8.5-6.5zM12.5 5.5v13L21 12z" fill="currentColor"/></svg>
      </button>
    </div>
    <${Player} soundOn=${soundOn} onSound=${onSound} />
    <div className="hud-sec mono">
      <span className="hud-idx">01</span>
      <span className="hud-line"><i></i></span>
      <span className="hud-name">Cheeni & Atharva</span>
    </div>
  </div>`;
}

function Cursor() {
  const ref = useRef();
  useEffect(() => {
    if (!FINE) return;
    const el = ref.current, dot = el.children[0], ring = el.children[1];
    let x = innerWidth / 2, y = innerHeight / 2, rx = x, ry = y;
    const mv = (e) => { x = e.clientX; y = e.clientY; el.classList.add("on");
      el.classList.toggle("link", !!e.target.closest("[data-hover], button, a")); };
    const dn = () => el.classList.add("down"), up = () => el.classList.remove("down");
    addEventListener("pointermove", mv, { passive: true }); addEventListener("pointerdown", dn); addEventListener("pointerup", up);
    const tick = () => { rx += (x - rx) * 0.16; ry += (y - ry) * 0.16;
      dot.style.transform = `translate3d(${x}px,${y}px,0)`; ring.style.transform = `translate3d(${rx}px,${ry}px,0)`; };
    gsap.ticker.add(tick);
    document.documentElement.classList.add("has-cursor");
    return () => { gsap.ticker.remove(tick); removeEventListener("pointermove", mv); };
  }, []);
  if (!FINE) return null;
  return html`<div className="cursor" ref=${ref} aria-hidden="true"><i className="c-dot"></i><i className="c-ring"></i></div>`;
}

function Gate({ progress, ready, onBegin }) {
  const pct = Math.round(progress * 100);
  return html`<div className="gate" id="gate">
    <div className="gate-in">
      <p className="mono gate-k">${ready ? "Our year is ready" : `Gathering stars · ${pct}%`}</p>
      <div className="gate-btn-wrap">
        <svg className="gate-ring" viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r="96" className="gr-bg"></circle>
          <circle cx="100" cy="100" r="96" className="gr-fg" style=${{ strokeDashoffset: 603 * (1 - progress) }}></circle>
        </svg>
        <${CircularText} text="PUT YOUR HEADPHONES ON ✦ SCROLL SLOWLY ✦ " radius=${78} />
        <button type="button" className="gate-btn" disabled=${!ready} onClick=${onBegin} data-hover>
          <span className="serif-i">${ready ? "Begin" : "…"}</span>
        </button>
      </div>
      <p className="gate-names"><span className="serif-i">${CFG.her} & ${CFG.me}</span></p>
      <p className="mono gate-song">♪ ${CFG.songTitle}</p>
    </div>
  </div>`;
}

/* ================================================================
   App
   ================================================================ */
function App() {
  const canvasRef = useRef(), hudRef = useRef();
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [begun, setBegun] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [won, setWon] = useState(false);
  const [phone, setPhone] = useState(isPhone());
  // full-screen viewer for the memories strips; the browser Back button closes it
  const [view, setView] = useState(null);
  const pushed = useRef(false);
  const openViewer = (stop, i) => {
    setView({ stop, i });
    try { history.pushState({ vw: 1 }, ""); pushed.current = true; } catch (e) { pushed.current = false; }
  };
  const closeViewer = () => { if (pushed.current) { pushed.current = false; history.back(); } else setView(null); };
  const navViewer = (d) => setView((v) => v && { stop: v.stop, i: (v.i + d + v.stop.media.length) % v.stop.media.length });
  useEffect(() => {
    const pop = () => { pushed.current = false; setView(null); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  // rebuild scroll timelines if the screen crosses the phone breakpoint (rotation, resize)
  useEffect(() => {
    let t;
    const on = () => { clearTimeout(t); t = setTimeout(() => setPhone(isPhone()), 250); };
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  useEffect(() => { requestAnimationFrame(() => ScrollTrigger.refresh()); }, [phone]);
  const qStop = STOPS.find((s) => s.type === "question");

  useEffect(() => {
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
    const lenis = (app.lenis = new Lenis({ lerp: REDUCED ? 0.5 : 0.08, smoothWheel: true, wheelMultiplier: 0.8, touchMultiplier: 1.3 }));
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();

    let cosmos = null;

    // where each stop "holds" in scroll space
    let holds = [], names = [], chimes = [], isLane = [], realIdx = [], realN = 1;
    const measure = () => {
      const vh = innerHeight, els = [...document.querySelectorAll("[data-stop]")];
      holds = els.map((el) => el.getBoundingClientRect().top + scrollY + (el.offsetHeight - vh) / 2);
      holds[0] = 0;
      names = els.map((el) => el.dataset.name);
      chimes = els.map((el) => el.dataset.chime);
      isLane = els.map((el) => !!el.dataset.lane);
      let r = 0; realIdx = isLane.map((l) => (l ? r : ++r)); realN = r;
      // phones: tell the 3D layer where each chapter's text begins, so photos stop above it
      if (cosmos && cosmos.setTextTops) {
        const tops = {};
        document.querySelectorAll(".sec-ch").forEach((sec) => {
          const col = sec.querySelector(".ch-col"), pin = sec.querySelector(".pin");
          if (col && pin && pin.clientHeight) tops[+sec.dataset.stop] = col.offsetTop / pin.clientHeight;
        });
        cosmos.setTextTops(tops);
      }
      lanes = {};
      document.querySelectorAll("[data-lane-key]").forEach((el) => {
        lanes[el.dataset.laneKey] = { el, d: el.querySelector("[data-ld]"), t: el.querySelector("[data-lt]"), c: el.querySelector("[data-lc]"), b: el.querySelector("[data-lb]") };
      });
    };
    let lanes = {}, laneShown = null, laneOn = null, hoverTick = 0;
    const sAt = (y) => {
      if (!holds.length) return 0;
      if (y <= holds[0]) return 0;
      for (let k = 0; k < holds.length - 1; k++) if (y < holds[k + 1]) return k + (y - holds[k]) / (holds[k + 1] - holds[k]);
      return holds.length - 1;
    };
    ScrollTrigger.addEventListener("refresh", measure);
    measure();

    const hud = hudRef.current;
    const bar = hud.querySelector(".hud-bar-top i"), line = hud.querySelector(".hud-line i");
    const idxEl = hud.querySelector(".hud-idx"), nameEl = hud.querySelector(".hud-name");
    let cur = -1, prevY = 0;
    gsap.ticker.add((time, dms) => {
      const y = lenis.scroll ?? scrollY;
      const s = sAt(y);
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      if (cosmos) { cosmos.level = sound.level(); cosmos.update(dms / 1000, s); }
      // scene text follows the same scroll position as the page it sits on
      driveScrubs(y);
      bar.style.transform = `scaleX(${clamp(y / max, 0, 1)})`;
      const k = clamp(Math.round(s), 0, names.length - 1);
      line.style.transform = `scaleX(${clamp(1 - Math.abs(s - k) * 2, 0, 1)})`;
      if (k !== cur) {
        cur = k;
        idxEl.textContent = String(Math.max(1, realIdx[k] || 1)).padStart(2, "0") + " / " + String(realN).padStart(2, "0");
        nameEl.textContent = names[k] || "";
        if (sound.started && k > 0 && !isLane[k]) sound.chime(chimes[k] ? Number(chimes[k]) : k);
      }
      // time-flies corridor: show the date (and caption) of the photo drifting past
      const ln = cosmos && cosmos.laneNow;
      const onKey = ln ? ln.key : null;
      if (onKey !== laneOn) {
        if (laneOn && lanes[laneOn]) lanes[laneOn].el.classList.remove("on");
        if (onKey && lanes[onKey]) lanes[onKey].el.classList.add("on");
        laneOn = onKey;
      }
      if (ln && lanes[ln.key] && laneShown !== ln.id) {
        laneShown = ln.id;
        const L = lanes[ln.key], m = MEDIA[ln.id] || {}, parts = (m.t || "").split(" · ");
        L.d.textContent = parts[0] || ""; L.t.textContent = (parts[1] || "") + (m.v ? "  ·  ▶ video" : "");
        L.c.textContent = CAPS[ln.id] || "";
        L.b.style.transform = `scaleX(${(ln.i + 1) / ln.n})`;
        L.d.classList.remove("tick"); void L.d.offsetWidth; L.d.classList.add("tick");
      }
      // a ring cursor when hovering a photo you can open
      if (cosmos && FINE && cosmos.hoverAt && ++hoverTick % 6 === 0) {
        document.documentElement.classList.toggle("over-photo", !!cosmos.hitAt(cosmos.hoverAt[0], cosmos.hoverAt[1]));
      }
      const v = Math.abs(lenis.velocity || (y - prevY)) / 40; prevY = y;
      sound.whoosh(cosmos ? Math.abs(cosmos.vel) : v);
    });

    const done = () => { setReady(true); ScrollTrigger.refresh(); measure(); };
    (async () => {
      try {
        const { Cosmos } = await import("./cosmos.js");
        cosmos = app.cosmos = new Cosmos(canvasRef.current, PATH, { reduced: REDUCED, media: MEDIA });
        cosmos.onPick = ({ key, id }) => {
          const st = CHAPTERS.find((c) => c.key === key);
          if (st && st.media.indexOf(id) >= 0) openViewer(st, st.media.indexOf(id));
        };
        await cosmos.load((p) => setProgress(p));
      } catch (e) {
        console.error(e); cosmos = app.cosmos = null;
        document.documentElement.classList.add("no-gl"); setProgress(1);
      }
      done();
    })();
    const fallbackTimer = setTimeout(() => setReady(true), 12000);
    addEventListener("load", () => { ScrollTrigger.refresh(); measure(); });
    return () => clearTimeout(fallbackTimer);
  }, []);

  const begin = () => {
    // phones & tablets: tilt the device to swing the sky (iPhone/iPad ask for permission here, on the tap)
    if (matchMedia("(pointer: coarse)").matches && !REDUCED && "DeviceOrientationEvent" in window) {
      const on = () => { if (app.cosmos && app.cosmos.enableMotion) app.cosmos.enableMotion(); };
      try {
        if (typeof DeviceOrientationEvent.requestPermission === "function") {
          DeviceOrientationEvent.requestPermission().then((r) => { if (r === "granted") on(); }).catch(() => {});
        } else on();
      } catch (e) {}
    }
    sound.start();
    setBegun(true);
    document.documentElement.classList.add("begun");
    gsap.to("#gate", { opacity: 0, duration: 1.6, ease: "power2.inOut", onComplete: () => { const g = document.getElementById("gate"); if (g) g.style.display = "none"; } });
    gsap.to("#gate .gate-in", { scale: 1.15, filter: bl(10), duration: 1.6, ease: "power2.in" });
    if (app.cosmos) gsap.to(app.cosmos, { intro: 0, duration: REDUCED ? 0.5 : 3.6, ease: "power3.inOut" });
    gsap.fromTo(hudRef.current, { opacity: 0 }, { opacity: 1, duration: 1.5, delay: 1.6 });
    setTimeout(() => app.lenis.start(), REDUCED ? 600 : 3000);
  };
  const toggleSound = () => setSoundOn(sound.toggle());
  // fast-forward: fly silently to the very end and back to the start (warms every scene and photo)
  const [ff, setFF] = useState(false);
  const fastForward = () => {
    if (app.ffBusy || won || !app.lenis) return;
    app.ffBusy = true; setFF(true);
    const wasOn = sound.on;
    if (wasOn) setSoundOn(sound.toggle());
    const L = app.lenis, ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const done = () => { app.ffBusy = false; setFF(false); if (wasOn && !sound.on) setSoundOn(sound.toggle()); };
    L.start();
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    L.scrollTo(max, { duration: FF_DOWN, easing: ease, lock: true, force: true, onComplete: () =>
      setTimeout(() => L.scrollTo(0, { duration: FF_UP, easing: ease, lock: true, force: true, onComplete: done }), 300) });
  };
  // the HUD shows whichever song is playing (when there's more than one)
  // (the player watches sound.cur itself and shows a toast when the song changes)
  const yes = () => {
    if (won) return;
    sound.sparkle();
    app.cosmos && app.cosmos.celebrate();
    hearts(60);
    setWon(true);
    app.lenis.stop();
  };
  const replay = () => {
    setWon(false);
    app.resetNo && app.resetNo();
    app.lenis.start();
    app.lenis.scrollTo(0, { duration: REDUCED ? 1 : 10, easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) });
  };

  let chapterN = -1;
  let stopIdx = -1;
  return html`
    <canvas className="gl" ref=${canvasRef} aria-hidden="true"></canvas>
    <div className="grain" aria-hidden="true"></div>
    <${Hud} soundOn=${soundOn} onSound=${toggleSound} hudRef=${hudRef} onFF=${fastForward} ff=${ff} />
    ${ff && html`<div className="ff-toast mono" role="status"><span>Fast-forwarding through our year</span><i style=${{ animationDuration: FF_DOWN + FF_UP + "s" }}></i></div>`}
    <main className="story" key=${phone ? "p" : "d"}>
      ${STOPS.map((s, i) => {
        if (s.type !== "marquee") stopIdx++;
        const k = stopIdx;
        if (s.type === "lane") stopIdx++; // a corridor is two stops (its start and its end)
        switch (s.type) {
          case "hero": return html`<${Hero} key=${i} begun=${begun} />`;
          case "prologue": return html`<${Prologue} key=${i} stop=${s} idx=${k} />`;
          case "chapter": chapterN++; return html`<${Chapter} key=${i} stop=${s} idx=${k} n=${chapterN} />`;
          case "lane": return html`<${Lane} key=${i} stop=${s} idx=${k} />`;
          case "dayone": return html`<${DayOne} key=${i} stop=${s} idx=${k} />`;
          case "marquee": return html`<${Marquee} key=${i} rows=${s.rows} />`;
          case "stats": return html`<${Stats} key=${i} stop=${s} idx=${k} />`;
          case "letter": return html`<${Letter} key=${i} stop=${s} idx=${k} />`;
          case "question": return html`<${Question} key=${i} stop=${s} idx=${k} onYes=${yes} won=${won} />`;
          default: return null;
        }
      })}
    </main>
    ${won && html`<${Celebration} stop=${qStop} onReplay=${replay} />`}
    ${view && html`<${Viewer} view=${view} onNav=${navViewer} onClose=${closeViewer} />`}
    <${Cursor} />
    <${Gate} progress=${progress} ready=${ready} onBegin=${begin} />
  `;
}

/* floating DOM hearts for the YES moment */
function hearts(n) {
  for (let i = 0; i < n; i++) {
    const d = document.createElement("span");
    d.className = "fh"; d.textContent = Math.random() < 0.75 ? "♥" : "✦";
    d.style.left = rand(2, 98) + "vw";
    d.style.fontSize = rand(12, 34) + "px";
    d.style.color = ["#ff8fb1", "#f2c27b", "#ffd6e2", "#b9a8ff"][i % 4];
    document.body.appendChild(d);
    gsap.fromTo(d, { y: innerHeight + 40, opacity: 0 }, {
      y: -80, x: rand(-80, 80), rotate: rand(-90, 90), opacity: 1, duration: rand(3, 6), delay: rand(0, 2.5), ease: "power1.out",
      onComplete: () => d.remove()
    });
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
