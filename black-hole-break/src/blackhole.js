/*
 * Black hole effect: pure core (no `vscode` import). Shared by the extension,
 * the unit tests and the browser preview.
 *
 * Geometry
 * --------
 * The hole sits at (hole.col, hole.line). Each chunk of code (1-3 characters)
 * gets its vector from the hole as two CSS custom properties, from two
 * stacked decorations on the same range:
 *     --bh-x: <columns * 1ch>      --bh-y: <lines * 1lh>
 * A stage decoration then moves the chunk along a spiral into the hole:
 *     new = r(p) * Rot(theta(p)) * v      offset = new - v
 *     offset.x = A*vx - B*vy,  offset.y = B*vx + A*vy
 *     A = r cos(theta) - 1,    B = r sin(theta)
 * `ch` and `lh` make it exact for any font size and line height.
 *
 * Time model
 * ----------
 * Everything is a pure function of t in [0, DURATION]:
 *   hole grows -> chunks redshift, then spiral in (nearest first) ->
 *   hole collapses -> flash. Reverse play is a white hole: code spirals out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlackHoleCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DRAIN = 3;          // redshift levels before the fall
  const VARIANTS = 4;       // orbit variants (how many turns)
  const STAGES = 16;        // fall stages per variant
  const GONE = DRAIN + VARIANTS * STAGES;
  const TYPE_COUNT = GONE + 1;
  const NORMAL = -1;
  const FLASH = 4;

  const VX_MAX = 400;       // half-columns
  const VY_MAX = 150;       // lines

  const TIMING = {
    growEnd: 0.5,           // hole reaches full size
    firstAt: 0.35,          // first chunk starts to redshift
    drainLead: 0.3,
    sweep: 1.7,             // nearest chunks fall first, farthest last
    noise: 0.25,
    jitter: 0.12,
    lifeMin: 0.9,           // time to spiral in
    lifeMax: 1.6,
    collapseStart: 4.25,
    collapseEnd: 4.7,
    flashTime: 0.3
  };
  const DURATION = TIMING.collapseEnd + TIMING.flashTime + 0.05; // margin: the flash ends before the rest

  const THETA = [3.6, 4.6, 5.6, 6.6];   // total orbit angle per variant (rad)

  // ------------------------------------------------------------- random
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(ix, iy, seed) {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const smooth01 = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  const smoothstep = (a, b, x) => smooth01((x - a) / (b - a));
  function valueNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth01(x - ix), fy = smooth01(y - iy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    const top = a + (b - a) * fx;
    return top + ((c + (d - c) * fx) - top) * fy;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fix = (v, d = 3) => Number(v.toFixed(d));

  // ------------------------------------------------------------- layout
  /** Visual length of a line (tabs expanded). */
  function visualLength(text, tabSize) {
    let col = 0;
    for (let i = 0; i < text.length; i++) col = text[i] === '\t' ? col + tabSize - (col % tabSize) : col + 1;
    return col;
  }

  /**
   * Hole size follows the screen: the event-horizon radius (in lines) grows
   * with the number of visible lines, so a tall editor gets a large hole.
   *   radius = clamp(visibleLines * RADIUS_PER_LINE, RADIUS_MIN, RADIUS_MAX)
   * e.g. 20 lines -> 1.2, 32 lines -> 1.8, 60 lines -> 3.3 (diameter 2x).
   * `scale` (setting blackHoleBreak.holeScale) multiplies the result.
   */
  const RADIUS_PER_LINE = 0.055;
  const RADIUS_MIN = 1.2;
  const RADIUS_MAX = 6;
  const LINE_IN_COLUMNS = 2.4;     // a line is about 2.4 columns tall
  const DISK_ASPECT = 2.96;        // disk width / disk height

  function holeRadius(visibleLines, scale = 1) {
    const r = clamp(visibleLines * RADIUS_PER_LINE, RADIUS_MIN, RADIUS_MAX) * clamp(scale, 0.5, 3);
    return Math.round(r * 10) / 10;
  }

  /**
   * Pick the hole: middle visible line, column at half of the widest visible
   * line, radius from the visible height. The column is kept far enough from
   * the left edge for the whole disk to show.
   */
  function pickHole(lineTexts, firstLine, tabSize, scale = 1) {
    let maxLen = 0;
    for (const t of lineTexts) maxLen = Math.max(maxLen, visualLength(t, tabSize));
    const radius = holeRadius(lineTexts.length, scale);
    const minCol = Math.max(12, Math.ceil(radius * DISK_ASPECT * LINE_IN_COLUMNS));
    return {
      line: firstLine + Math.floor(lineTexts.length / 2),
      col: clamp(Math.round(maxLen * 0.5), minCol, Math.max(minCol, 60)),
      radius,
      span: lineTexts.length,
      maxLen
    };
  }

  /**
   * Chunks of one line with their vector to the hole and their timing.
   * Deterministic for (text, line, seed, hole, profile).
   * profile: timing fields as TIMING, plus `minDist` (columns): vectors
   * shorter than this are stretched to it (outward effects need a minimum
   * push; the timing still uses the true distance).
   */
  function lineChunks(text, line, seed, tabSize, hole, profile = TIMING) {
    const P = profile;
    const minDist = P.minDist || 0;
    const out = [];
    const rand = mulberry32(Math.floor(hash2(line, 11, seed) * 4294967296));
    const n = text.length;
    const maxLen = n > 600 ? Math.ceil(n / 200) : 3;
    const vy = clamp(line - hole.line, -VY_MAX, VY_MAX);
    let col = 0; // visual column
    let i = 0;
    while (i < n) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t') {
        col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1;
        i++;
        continue;
      }
      let j = i;
      while (j < n && text[j] !== ' ' && text[j] !== '\t') j++;
      let k = i;
      while (k < j) {
        const len = Math.min(j - k, 1 + Math.floor(rand() * maxLen));
        const vcol = col + (k - i);
        let vx = clamp(Math.round(2 * (vcol + len / 2 - hole.col)), -VX_MAX, VX_MAX); // half-columns
        let cvy = vy;
        const dist = Math.hypot(vx * 0.5, vy * LINE_IN_COLUMNS);
        const dn = Math.min(1, dist / 70);
        const delay = P.firstAt + P.drainLead +
          P.sweep * Math.pow(dn, 0.85) +
          P.noise * (valueNoise(vcol * 0.08, line * 0.25, seed) - 0.5) +
          P.jitter * rand();
        const life = P.lifeMin + (P.lifeMax - P.lifeMin) * rand();
        const variant = Math.floor(rand() * VARIANTS);
        if (minDist > 0 && dist < minDist) {
          const a = dist > 0.01 ? Math.atan2(vy * LINE_IN_COLUMNS, vx * 0.5) : rand() * Math.PI * 2;
          vx = Math.round(2 * minDist * Math.cos(a));
          cvy = Math.round((minDist * Math.sin(a) / LINE_IN_COLUMNS) * 4) / 4; // quarter lines
        }
        out.push({
          start: k,
          end: k + len,
          vx,
          vy: cvy,
          delay: Math.max(P.firstAt + P.drainLead, delay),
          life,
          lead: P.drainLead,
          variant
        });
        k += len;
      }
      col += j - i;
      i = j;
    }
    return out;
  }

  // ------------------------------------------------------------- state(t)
  function chunkState(c, t) {
    if (t >= c.delay + c.life) return GONE;
    if (t >= c.delay) {
      const p = (t - c.delay) / c.life;
      return DRAIN + c.variant * STAGES + Math.min(STAGES - 1, Math.floor(p * STAGES));
    }
    const lead = c.lead || TIMING.drainLead;
    const d0 = c.delay - lead;
    if (t >= d0) return Math.min(DRAIN - 1, Math.floor(((t - d0) / lead) * DRAIN));
    return NORMAL;
  }

  /** Hole size factor at time t (0 = no hole). */
  function holeSize(t) {
    if (t <= 0 || t >= TIMING.collapseEnd) return 0;
    let s;
    if (t < TIMING.growEnd) {
      const x = t / TIMING.growEnd;          // ease-out-back: slight overshoot
      const c1 = 1.7, c3 = c1 + 1;
      s = 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    } else {
      s = 1;
    }
    s *= 1 + 0.25 * smoothstep(TIMING.growEnd, TIMING.collapseStart, t);   // it feeds and grows
    if (t > TIMING.collapseStart) {
      const x = (t - TIMING.collapseStart) / (TIMING.collapseEnd - TIMING.collapseStart);
      s *= 1 - x * x * x;
    }
    return Math.max(0, s);
  }

  /** Quantised hole state: { size, angle } levels, or null. */
  function holeLevel(t) {
    const s = holeSize(t);
    if (s < 0.025) return null;
    return {
      size: Math.round(s * 20),                         // 0.05 steps
      angle: Math.round(((t * 150) % 360) / 15) % 24    // disk turns 150 deg/s
    };
  }

  function flashLevel(t) {
    const s = t - TIMING.collapseEnd;
    if (s <= 0 || s >= TIMING.flashTime) return -1;
    return Math.min(FLASH - 1, Math.floor((s / TIMING.flashTime) * FLASH));
  }

  // ------------------------------------------------------------- styles
  const lenX = (n) => `${fix(n * 0.5, 1)}ch`;

  /** Inline decoration that sets the x part of the vector (half-columns). */
  function vecXOptions(vx) { return { textDecoration: `none; --bh-x: ${lenX(vx)}` }; }
  /** Inline decoration that sets the y part of the vector (lines). */
  function vecYOptions(vy) { return { textDecoration: `none; --bh-y: ${vy}lh` }; }

  function translate(A, B) {
    return `translate: calc(${fix(A)} * var(--bh-x, 0px) - ${fix(B)} * var(--bh-y, 0px)) ` +
      `calc(${fix(B)} * var(--bh-x, 0px) + ${fix(A)} * var(--bh-y, 0px))`;
  }

  /** Colour of the falling grains: hot = orange (black hole), blue = blue shift (wormhole). */
  const PALETTES = {
    hot: { hue: -25, glow: '255,150,60', drainHue: 0 },
    blue: { hue: 175, glow: '120,190,255', drainHue: 150 }
  };

  function stageOptions(i, ghostOpacity, palette = 'hot') {
    const pal = PALETTES[palette] || PALETTES.hot;
    if (i < DRAIN) {
      const g = (i + 1) / DRAIN;
      return {
        textDecoration: `none; display: inline-block; ${translate(-0.04 * g, 0)}; ` +
          `filter: sepia(${fix(0.5 * g, 2)}) saturate(${fix(1 + 0.6 * g, 2)}) ` +
          `hue-rotate(${fix(pal.drainHue * g, 1)}deg) brightness(${fix(1 - 0.2 * g, 2)})`
      };
    }
    if (i === GONE) return { opacity: String(ghostOpacity), textDecoration: 'none' };

    const v = Math.floor((i - DRAIN) / STAGES);
    const k = (i - DRAIN) % STAGES;
    const p = (k + 0.5) / STAGES;
    const r = Math.pow(1 - p, 1.5);
    const theta = THETA[v] * Math.pow(p, 1.7);
    const A = r * Math.cos(theta) - 1;
    const B = r * Math.sin(theta);
    const heat = smoothstep(0.15, 0.75, p);
    const scale = Math.max(0.04, Math.pow(1 - p, 0.8));
    const opacity = p < 0.8 ? 1 : Math.max(0, (1 - p) / 0.2);
    return {
      opacity: String(fix(Math.max(opacity, ghostOpacity), 3)),
      textDecoration: `none; display: inline-block; ${translate(A, B)}; ` +
        `rotate: ${fix((theta * 180) / Math.PI, 1)}deg; scale: ${fix(scale)}; ` +
        `filter: sepia(${fix(heat, 2)}) saturate(${fix(1 + 3 * heat, 2)}) hue-rotate(${fix(pal.hue * heat, 1)}deg) ` +
        `brightness(${fix(1 + 0.8 * heat, 2)}) blur(${fix(0.8 * p, 2)}px); ` +
        `text-shadow: 0 0 ${fix(2 + 6 * heat, 1)}px rgba(${pal.glow},${fix(0.85 * heat, 2)})`
    };
  }

  const ABS = 'position: absolute; pointer-events: none; border-radius: 50%';

  /**
   * Accretion disk: tilted ring, conic gradient turned by angle level.
   * radius: event-horizon radius in lines (from pickHole).
   */
  function diskOptions(col, sizeLevel, angleLevel, radius = RADIUS_MIN) {
    const s = sizeLevel / 20;
    const a = angleLevel * 15;
    const h = 2 * radius * s;              // disk height = horizon diameter
    const w = DISK_ASPECT * h;
    return {
      contentText: '',
      textDecoration: `none; ${ABS}; z-index: 6; ` +
        `left: calc(${col}ch - ${fix(w / 2)}lh); top: calc(0.5lh - ${fix(h / 2)}lh); ` +
        `width: ${fix(w)}lh; height: ${fix(h)}lh; ` +
        `background: conic-gradient(from ${a}deg, rgba(255,110,40,0) 0deg, rgba(255,170,80,0.9) 50deg, ` +
        `rgba(255,240,205,1) 85deg, rgba(255,140,60,0.7) 140deg, rgba(255,110,40,0.05) 210deg, ` +
        `rgba(255,170,90,0.55) 290deg, rgba(255,110,40,0) 360deg); ` +
        `-webkit-mask: radial-gradient(closest-side, transparent 0 30%, #000 44% 66%, transparent 100%); ` +
        `mask: radial-gradient(closest-side, transparent 0 30%, #000 44% 66%, transparent 100%); ` +
        `filter: blur(${fix(0.045 * h)}lh) saturate(1.2)`
    };
  }

  /** Event horizon: black disk with a bright photon ring and a warm glow. */
  function shadowOptions(col, sizeLevel, radius = RADIUS_MIN) {
    const s = sizeLevel / 20;
    const d = 2 * radius * s;
    return {
      contentText: '',
      textDecoration: `none; ${ABS}; z-index: 7; ` +
        `left: calc(${col}ch - ${fix(d / 2)}lh); top: calc(0.5lh - ${fix(d / 2)}lh); ` +
        `width: ${fix(d)}lh; height: ${fix(d)}lh; ` +
        `background: radial-gradient(circle, #000 0 56%, #060302 61%, rgba(255,226,180,0.95) 65%, ` +
        `rgba(255,150,60,0.55) 71%, rgba(255,110,40,0) 80%); ` +
        `box-shadow: 0 0 ${fix(0.4 * d)}lh ${fix(0.05 * d)}lh rgba(255,140,60,0.3)`
    };
  }

  const FLASH_ALPHA = [0.14, 0.09, 0.05, 0.02];
  function flashOptions(level) {
    return { isWholeLine: true, backgroundColor: `rgba(255, 200, 140, ${FLASH_ALPHA[level]})` };
  }

  return {
    DRAIN, VARIANTS, STAGES, GONE, TYPE_COUNT, NORMAL, FLASH, TIMING, DURATION, VX_MAX, VY_MAX,
    RADIUS_MIN, RADIUS_MAX, LINE_IN_COLUMNS, DISK_ASPECT, THETA,
    clamp, fix, smoothstep, translate,
    visualLength, holeRadius, pickHole, lineChunks, chunkState, holeSize, holeLevel, flashLevel,
    vecXOptions, vecYOptions, stageOptions, diskOptions, shadowOptions, flashOptions
  };
});
