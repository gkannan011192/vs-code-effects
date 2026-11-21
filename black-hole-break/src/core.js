/*
 * Pure core: no `vscode` import. Shared by the extension, the unit tests and
 * the browser preview.
 *
 * Time model
 * ----------
 * A break animation runs on a timeline t in [0, DURATION] seconds.
 * Every visible chunk of code (1-3 characters) has a fixed `delay` and `life`.
 * Its look at time t is a pure function:
 *
 *   t <  delay - DRAIN_LEAD            -> normal
 *   t in [delay - DRAIN_LEAD, delay)   -> drain (colour fades to grey)
 *   t in [delay, delay + life)         -> flight stage = floor(p * STAGES), p = (t - delay) / life
 *   t >= delay + life                  -> gone
 *
 * The stage selects a pre-built decoration type (offset, blur, opacity).
 * Forward play dissolves the code; reverse play reassembles it, exactly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DustCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- constants
  const DRAIN = 3;          // drain levels
  const VARIANTS = 4;       // wind variants
  const STAGES = 12;        // flight stages per variant
  const FLASH = 4;          // flash levels
  const GONE = DRAIN + VARIANTS * STAGES;
  const TYPE_COUNT = GONE + 1;
  const NORMAL = -1;

  const TIMING = {
    firstAt: 0.2,      // first chunk starts to drain
    drainLead: 0.35,   // drain time before a chunk lifts off
    sweep: 1.4,        // spread of lift-off times across the code
    grainJitter: 0.12, // random extra delay per chunk
    lifeMin: 0.8,      // flight time range
    lifeMax: 1.5,
    flashTime: 0.35
  };

  const DURATION = TIMING.firstAt + TIMING.drainLead + TIMING.sweep + TIMING.grainJitter + TIMING.lifeMax + 0.05;

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

  const smooth = (t) => t * t * (3 - 2 * t);

  function valueNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return top + (bot - top) * fy;
  }

  /** Two-octave noise, result in [0, 1]. */
  function fbm(x, y, seed) {
    return 0.65 * valueNoise(x, y, seed) + 0.35 * valueNoise(x * 2.3 + 11.1, y * 2.3 + 5.7, seed + 17);
  }

  // ------------------------------------------------------------- chunks
  const isSpace = (ch) => ch === ' ' || ch === '\t';

  /**
   * Split one line into chunks of 1-3 characters (whitespace skipped).
   * Deterministic for (text, line, seed): any editor computes the same delays.
   */
  function lineChunks(text, line, seed) {
    const out = [];
    const rand = mulberry32(Math.floor(hash2(line, 7, seed) * 4294967296));
    const n = text.length;
    const maxLen = n > 600 ? Math.ceil(n / 200) : 3; // keep very long lines cheap
    let i = 0;
    while (i < n) {
      if (isSpace(text[i])) { i++; continue; }
      let j = i;
      while (j < n && !isSpace(text[j])) j++;
      let k = i;
      while (k < j) {
        const len = Math.min(j - k, 1 + Math.floor(rand() * maxLen));
        const col = k;
        const colNorm = Math.min(1, col / 100);
        // dissolve front: right side of a line goes first (downwind), noise breaks the edge
        const f = 0.45 * (1 - colNorm) + 0.55 * fbm(col * 0.06, line * 0.22, seed);
        out.push({
          start: k,
          end: k + len,
          delay: TIMING.firstAt + TIMING.drainLead + TIMING.sweep * Math.min(1, f) + TIMING.grainJitter * rand(),
          life: TIMING.lifeMin + (TIMING.lifeMax - TIMING.lifeMin) * rand(),
          variant: Math.floor(rand() * VARIANTS)
        });
        k += len;
      }
      i = j;
    }
    return out;
  }

  /** Decoration type index for a chunk at time t, or NORMAL (-1). */
  function chunkState(c, t) {
    if (t >= c.delay + c.life) return GONE;
    if (t >= c.delay) {
      const p = (t - c.delay) / c.life;
      return DRAIN + c.variant * STAGES + Math.min(STAGES - 1, Math.floor(p * STAGES));
    }
    const drainStart = c.delay - TIMING.drainLead;
    if (t >= drainStart) {
      return Math.min(DRAIN - 1, Math.floor(((t - drainStart) / TIMING.drainLead) * DRAIN));
    }
    return NORMAL;
  }

  /** Flash level index for time t, or -1 when no flash. */
  function flashLevel(t) {
    if (t <= 0 || t > TIMING.flashTime) return -1;
    const a = Math.exp(-t * 9);              // 1 -> ~0.04
    return Math.min(FLASH - 1, Math.floor((1 - a) * FLASH));
  }

  // ------------------------------------------------------------- styles
  const fix = (v, d = 2) => Number(v.toFixed(d));

  /**
   * Decoration render options for type i. VS Code copies `textDecoration` into
   * the CSS rule as-is, which is how the offset and the filter get in.
   */
  function typeOptions(i, ghostOpacity) {
    if (i < DRAIN) {
      const g = (i + 1) / DRAIN;
      return { textDecoration: `none; filter: grayscale(${fix(g)}) brightness(${fix(1 - 0.12 * g)})` };
    }
    if (i === GONE) {
      return { opacity: String(ghostOpacity), textDecoration: 'none; filter: grayscale(1)' };
    }
    const v = Math.floor((i - DRAIN) / STAGES);
    const k = (i - DRAIN) % STAGES;
    const p = (k + 0.5) / STAGES;
    const dist = 24 + v * 14;                                  // css px
    const dx = dist * (0.3 * p + 0.7 * p * p);                 // wind accelerates the grain
    const dy = -dist * 0.5 * p + 3 * Math.sin(p * Math.PI * 2 + v * 1.7);
    const opacity = 0.95 * Math.pow(1 - p, 1.4);
    const blur = 0.2 + 1.6 * p;
    const scale = 1 - 0.55 * p;                                // grains crumble smaller
    const rot = (v - 1.5) * 14 * p;                            // and tumble
    // inline-block lets transform apply; transform does not change the layout,
    // so the cursor and the other text stay where they are.
    return {
      opacity: String(fix(Math.max(opacity, ghostOpacity), 3)),
      textDecoration: `none; display: inline-block; ` +
        `transform: translate(${fix(dx)}px, ${fix(dy)}px) rotate(${fix(rot)}deg) scale(${fix(scale)}); ` +
        `filter: grayscale(1) sepia(0.35) blur(${fix(blur)}px)`
    };
  }

  const FLASH_ALPHA = [0.16, 0.1, 0.06, 0.03];
  function flashOptions(level) {
    return { isWholeLine: true, backgroundColor: `rgba(255, 214, 150, ${FLASH_ALPHA[level]})` };
  }

  // ------------------------------------------------------------- schedule
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /**
   * "09:00-12:00, 13:00-18:00" -> [[540, 720], [780, 1080]] (minutes of day).
   * Empty string -> null (always active). Overnight ranges such as
   * "22:00-02:00" are allowed. Throws on invalid input.
   */
  function parseHours(spec) {
    if (!spec || !String(spec).trim()) return null;
    return String(spec).split(',').map((part) => {
      const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!m) throw new Error(`Invalid time range "${part.trim()}". Use HH:MM-HH:MM.`);
      const [h1, m1, h2, m2] = m.slice(1).map(Number);
      if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) throw new Error(`Invalid time range "${part.trim()}".`);
      return [h1 * 60 + m1, h2 * 60 + m2];
    });
  }

  function inSchedule(date, ranges, days) {
    if (days && days.length && !days.includes(DAY_NAMES[date.getDay()])) return false;
    if (!ranges) return true;
    const min = date.getHours() * 60 + date.getMinutes();
    return ranges.some(([a, b]) => {
      if (a === b) return true;
      return a < b ? min >= a && min < b : min >= a || min < b;
    });
  }

  // ------------------------------------------------------------- format
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtMinutes(ms) {
    const m = Math.ceil(ms / 60000);
    return m <= 1 ? '<1m' : `${m}m`;
  }

  return {
    DRAIN, VARIANTS, STAGES, FLASH, GONE, TYPE_COUNT, NORMAL, TIMING, DURATION, DAY_NAMES,
    mulberry32, hash2, fbm, lineChunks, chunkState, flashLevel,
    typeOptions, flashOptions, parseHours, inSchedule, fmtCountdown, fmtMinutes
  };
});
