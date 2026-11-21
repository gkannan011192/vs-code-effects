/*
 * Cosmic effects: black hole, wormhole, supernova. Pure (no `vscode`).
 *
 * Every effect is a spec with the same shape, so one renderer draws all:
 *
 *   name, DURATION, TYPE_COUNT, GONE, FLASH
 *   profile                         grain timing (see blackhole.lineChunks)
 *   anchors(lines, first, tab, k)   anchor points (hole centres) for a window
 *   anchorIndex(returning)          which anchor the grains move to / from
 *   stageOptions(i, ghost)          decoration for stage type i
 *   overlays(t, anchors, idx)       [{ key, line, opts }] drawn at time t
 *   flashLevel(t), flashOptions(l)  whole-screen flash
 *
 * Grain motion always uses the same CSS: each grain carries its vector v from
 * the anchor (--bh-x / --bh-y); a stage moves it to r * Rot(theta) * v.
 *   black hole / wormhole: r -> 0 (spiral in)
 *   supernova:             r -> 6.5 (blast out)
 * Overlays are empty `content: ''` attachments with absolute position.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./blackhole'));
  else root.CosmicCore = factory(root.BlackHoleCore);
})(typeof self !== 'undefined' ? self : this, function (bh) {
  'use strict';

  const { clamp, fix, smoothstep, translate, holeRadius, holeLevel, LINE_IN_COLUMNS, DISK_ASPECT } = bh;
  const ABS = 'position: absolute; pointer-events: none; border-radius: 50%';

  /** An element centred on (col, middle of the anchor line), size in lines. */
  function orb(col, w, h, z, css) {
    return {
      contentText: '',
      textDecoration: `none; ${ABS}; z-index: ${z}; ` +
        `left: calc(${col}ch - ${fix(w / 2)}lh); top: calc(0.5lh - ${fix(h / 2)}lh); ` +
        `width: ${fix(w)}lh; height: ${fix(h)}lh; ${css}`
    };
  }
  const before = (o) => ({ before: o });

  // ======================================================== black hole
  const blackHole = {
    name: 'blackHole',
    DURATION: bh.DURATION,
    TYPE_COUNT: bh.TYPE_COUNT,
    GONE: bh.GONE,
    FLASH: bh.FLASH,
    profile: bh.TIMING,
    anchors: (lines, first, tab, k) => [bh.pickHole(lines, first, tab, k)],
    anchorIndex: () => 0,
    stageOptions: (i, ghost) => bh.stageOptions(i, ghost, 'hot'),
    overlays(t, anchors) {
      const a = anchors[0];
      const lvl = holeLevel(t);
      if (!lvl) return [];
      return [
        { key: `bh-d|${a.col}|${a.radius}|${lvl.size}|${lvl.angle}`, line: a.line,
          opts: { before: bh.diskOptions(a.col, lvl.size, lvl.angle, a.radius) } },
        { key: `bh-s|${a.col}|${a.radius}|${lvl.size}`, line: a.line,
          opts: { after: bh.shadowOptions(a.col, lvl.size, a.radius) } }
      ];
    },
    flashLevel: bh.flashLevel,
    flashOptions: bh.flashOptions
  };

  // ======================================================== wormhole
  /*
   * Two mouths. The grains spiral into mouth A. After the rest (all code is
   * gone, so the switch is invisible), the grain vectors point to mouth B and
   * reverse play makes the code spiral out of B. If the break ends early,
   * the code goes back out of A.
   */
  function wormholeAnchors(lines, first, tab, k) {
    const base = bh.pickHole(lines, first, tab, k);
    const radius = Math.round(base.radius * 0.85 * 10) / 10;
    const n = lines.length;
    const half = Math.ceil(radius * 2.2 * LINE_IN_COLUMNS);    // swirl half-width in columns
    const minCol = Math.max(12, half);
    const width = Math.max(base.maxLen, 2 * minCol + 24);
    const aCol = clamp(Math.round(width * 0.28), minCol, 70);
    const bCol = Math.max(aCol + 2 * half + 6, Math.round(width * 0.72));
    return [
      { line: first + Math.floor(n * 0.32), col: aCol, radius, span: n },
      { line: first + Math.floor(n * 0.7), col: Math.min(bCol, 110), radius, span: n }
    ];
  }

  function mouthOverlays(a, lvl, tag) {
    const s = lvl.size / 20;
    const d = 2 * a.radius * s;          // throat diameter
    const sw = 2.2 * d;                  // swirl diameter
    const ang = lvl.angle * 15;
    return [
      { key: `wh-w|${tag}|${a.col}|${a.line}|${a.radius}|${lvl.size}|${lvl.angle}`, line: a.line,
        opts: before(orb(a.col, sw, sw, 6,
          `background: conic-gradient(from ${ang}deg, rgba(90,120,255,0) 0deg, rgba(120,160,255,0.85) 60deg, ` +
          `rgba(200,230,255,0.95) 95deg, rgba(160,100,255,0.7) 160deg, rgba(90,120,255,0.05) 220deg, ` +
          `rgba(110,200,255,0.6) 300deg, rgba(90,120,255,0) 360deg); ` +
          `-webkit-mask: radial-gradient(closest-side, transparent 0 34%, #000 46% 66%, transparent 100%); ` +
          `mask: radial-gradient(closest-side, transparent 0 34%, #000 46% 66%, transparent 100%); ` +
          `filter: blur(${fix(0.035 * sw)}lh) saturate(1.3)`)) },
      { key: `wh-t|${tag}|${a.col}|${a.line}|${a.radius}|${lvl.size}`, line: a.line,
        opts: { after: orb(a.col, d, d, 7,
          `background: radial-gradient(circle, rgba(215,235,255,0.9) 0 7%, rgba(120,150,255,0.55) 14%, ` +
          `#0b1030 26%, #060a1e 54%, rgba(150,225,255,0.95) 63%, rgba(150,95,255,0.55) 71%, rgba(90,120,255,0) 81%); ` +
          `box-shadow: 0 0 ${fix(0.45 * d)}lh ${fix(0.06 * d)}lh rgba(110,140,255,0.35)`) } }
    ];
  }

  const wormhole = {
    name: 'wormhole',
    DURATION: bh.DURATION,
    TYPE_COUNT: bh.TYPE_COUNT,
    GONE: bh.GONE,
    FLASH: bh.FLASH,
    profile: bh.TIMING,
    anchors: wormholeAnchors,
    anchorIndex: (returning) => (returning ? 1 : 0),
    stageOptions: (i, ghost) => bh.stageOptions(i, ghost, 'blue'),
    overlays(t, anchors, idx) {
      const lvl = holeLevel(t);
      if (!lvl) return [];
      return mouthOverlays(anchors[idx] || anchors[0], lvl, idx === 1 ? 'B' : 'A');
    },
    flashLevel: bh.flashLevel,
    flashOptions(level) {
      const alpha = [0.13, 0.08, 0.045, 0.02][level];
      return { isWholeLine: true, backgroundColor: `rgba(150, 175, 255, ${alpha})` };
    }
  };

  // ======================================================== supernova
  /*
   * 0.00-0.75  a star core forms, the code is pulled in and heats up
   * 0.75       core collapse -> explosion: flash + shockwave
   * 0.75-3.6   the shock front reaches each grain (nearest first); the grain
   *            flies outward, white-hot -> orange -> dark
   * 0.9-4.0    a nebula expands and fades; a small neutron star pulses
   * Reverse play: the code implodes back to its place.
   */
  const SN = {
    explode: 0.75,
    shockTime: 1.5,
    nebulaFrom: 0.9,
    nebulaTo: 4.0,
    starTo: 3.7,
    flashTime: 0.3
  };
  const SN_PROFILE = {
    firstAt: 0.35, drainLead: 0.4,            // firstAt + drainLead = explosion
    sweep: 1.0, noise: 0.1, jitter: 0.08,     // shock front travel
    lifeMin: 1.0, lifeMax: 1.7,
    minDist: 14                               // grains near the core still fly
  };
  const SN_DURATION = SN.nebulaTo + 0.05;
  const SN_SWIRL = [-0.45, -0.18, 0.18, 0.45];

  function supernovaStage(i, ghost) {
    const { DRAIN, STAGES, GONE } = bh;
    if (i < DRAIN) {
      const g = (i + 1) / DRAIN;     // pulled in and heated by the core
      return {
        textDecoration: `none; display: inline-block; ${translate(-0.06 * g, 0)}; ` +
          `filter: sepia(${fix(0.4 * g, 2)}) saturate(${fix(1 + g, 2)}) brightness(${fix(1 + 0.5 * g, 2)}); ` +
          `text-shadow: 0 0 ${fix(3 * g, 1)}px rgba(255,235,190,${fix(0.6 * g, 2)})`
      };
    }
    if (i === GONE) return { opacity: String(ghost), textDecoration: 'none' };
    const v = Math.floor((i - DRAIN) / STAGES);
    const k = (i - DRAIN) % STAGES;
    const p = (k + 0.5) / STAGES;
    const r = 1 + 5.5 * Math.pow(p, 1.3);
    const theta = SN_SWIRL[v] * p;
    const A = r * Math.cos(theta) - 1;
    const B = r * Math.sin(theta);
    const opacity = Math.pow(1 - p, 1.3);
    return {
      opacity: String(fix(Math.max(opacity, ghost), 3)),
      textDecoration: `none; display: inline-block; ${translate(A, B)}; ` +
        `rotate: ${fix(theta * 4 * 57.3, 1)}deg; scale: ${fix(1 - 0.5 * p)}; ` +
        `filter: sepia(${fix(0.6 + 0.4 * p, 2)}) saturate(${fix(1.5 + 2 * p, 2)}) hue-rotate(${fix(-20 * p, 1)}deg) ` +
        `brightness(${fix(2.2 - 1.6 * p, 2)}) blur(${fix(0.2 + 1.8 * p, 2)}px); ` +
        `text-shadow: 0 0 ${fix(8 - 6 * p, 1)}px rgba(255,230,180,${fix(0.9 * (1 - p), 2)})`
    };
  }

  /** Core size factor before the explosion. */
  function coreSize(t) {
    if (t <= 0 || t >= SN.explode) return 0;
    const grow = smoothstep(0, 0.45, t);
    const pulse = 1 + 0.08 * Math.sin(t * 40);
    const collapse = 1 - 0.75 * smoothstep(0.6, SN.explode, t);
    return grow * pulse * collapse;
  }

  function supernovaOverlays(t, anchors) {
    const a = anchors[0];
    const out = [];
    const R = a.radius;

    const cs = Math.round(coreSize(t) * 20);
    if (cs > 0) {
      const d = 1.6 * R * (cs / 20);
      out.push({ key: `sn-c|${a.col}|${R}|${cs}`, line: a.line, opts: before(orb(a.col, d, d, 8,
        `background: radial-gradient(circle, #fff 0 18%, rgba(255,245,200,0.95) 30%, ` +
        `rgba(255,190,90,0.55) 52%, rgba(255,150,60,0) 72%); ` +
        `box-shadow: 0 0 ${fix(0.8 * d)}lh ${fix(0.15 * d)}lh rgba(255,210,140,0.45)`)) });
    }

    const qs = (t - SN.explode) / SN.shockTime;
    if (qs > 0 && qs < 1) {
      const lvl = Math.min(29, Math.floor(qs * 30));
      const q = (lvl + 0.5) / 30;
      const e = 1 - Math.pow(1 - q, 3);
      const d = 2 * (0.6 + 0.75 * a.span) * e;
      const al = Math.pow(1 - q, 1.6);
      out.push({ key: `sn-r|${a.col}|${a.span}|${lvl}`, line: a.line, opts: before(orb(a.col, d, d, 9,
        `background: radial-gradient(circle, rgba(255,240,210,0) 0 60%, rgba(255,240,210,${fix(0.75 * al)}) 68%, ` +
        `rgba(255,160,80,${fix(0.45 * al)}) 74%, rgba(255,140,60,0) 80%)`)) });
    }

    const qn = (t - SN.nebulaFrom) / (SN.nebulaTo - SN.nebulaFrom);
    if (qn > 0 && qn < 1) {
      const lvl = Math.min(29, Math.floor(qn * 30));
      const q = (lvl + 0.5) / 30;
      const d = 2 * 0.45 * a.span * (0.2 + 0.8 * Math.sqrt(q));
      const op = smoothstep(0, 0.2, q) * (1 - smoothstep(0.55, 1, q)) * 0.6;
      out.push({ key: `sn-n|${a.col}|${a.span}|${lvl}`, line: a.line, opts: before(orb(a.col, d, d * 0.8, 3,
        `opacity: ${fix(op)}; rotate: ${fix(q * 40, 1)}deg; ` +
        `background: radial-gradient(circle at 36% 42%, rgba(255,205,130,0.35), rgba(255,205,130,0) 45%), ` +
        `radial-gradient(circle at 64% 58%, rgba(110,210,255,0.35), rgba(110,210,255,0) 50%), ` +
        `radial-gradient(closest-side, rgba(255,120,190,0) 0 12%, rgba(255,120,180,0.55) 32%, ` +
        `rgba(120,190,255,0.4) 52%, rgba(150,110,255,0.28) 68%, rgba(150,110,255,0) 100%); ` +
        `filter: blur(${fix(0.06 * d)}lh)`)) });
    }

    if (t > SN.explode && t < SN.starTo) {
      const pulse = Math.floor(t * 6) % 4;
      const fade = Math.min(5, Math.floor(smoothstep(SN.starTo - 0.7, SN.starTo, t) * 6));
      const op = fix((0.6 + 0.13 * pulse) * (1 - fade / 6));
      out.push({ key: `sn-p|${a.col}|${pulse}|${fade}`, line: a.line, opts: { after: orb(a.col, 0.35, 0.35, 10,
        `opacity: ${op}; background: radial-gradient(circle, #fff 0 30%, rgba(170,210,255,0.8) 50%, rgba(170,210,255,0) 75%); ` +
        `box-shadow: 0 0 0.5lh 0.1lh rgba(170,210,255,0.5)`) } });
    }
    return out;
  }

  const supernova = {
    name: 'supernova',
    DURATION: SN_DURATION,
    TYPE_COUNT: bh.TYPE_COUNT,
    GONE: bh.GONE,
    FLASH: 4,
    profile: SN_PROFILE,
    anchors: (lines, first, tab, k) => [bh.pickHole(lines, first, tab, k)],
    anchorIndex: () => 0,
    stageOptions: supernovaStage,
    overlays: supernovaOverlays,
    flashLevel(t) {
      const s = t - SN.explode;
      if (s <= 0 || s >= SN.flashTime) return -1;
      return Math.min(3, Math.floor((s / SN.flashTime) * 4));
    },
    flashOptions(level) {
      const alpha = [0.2, 0.12, 0.06, 0.025][level];
      return { isWholeLine: true, backgroundColor: `rgba(255, 240, 220, ${alpha})` };
    }
  };

  const SPECS = { blackHole, wormhole, supernova };
  const EFFECTS = Object.keys(SPECS);

  return { SPECS, EFFECTS, SN, SN_PROFILE, coreSize, wormholeAnchors, getSpec: (name) => SPECS[name] || blackHole };
});
