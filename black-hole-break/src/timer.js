/*
 * Break timer. Counts active time (VS Code window focused, inside the
 * schedule, not paused). Time away from the window longer than
 * `awayResetMs` counts as a natural break and resets the timer.
 */
'use strict';

const MAX_STEP_MS = 5000; // a sleeping laptop must not count as active time

class BreakTimer {
  constructor() {
    this.activeMs = 0;
    this.awayMs = 0;
    this.last = null;
  }

  /**
   * @param {number} nowMs monotonic ms
   * @param {{focused: boolean, counting: boolean, intervalMs: number, awayResetMs: number}} s
   * @returns {boolean} true when a break is due
   */
  update(nowMs, s) {
    const dt = this.last === null ? 0 : Math.max(0, Math.min(nowMs - this.last, MAX_STEP_MS));
    this.last = nowMs;
    if (!s.counting) return false;
    if (s.focused) {
      this.activeMs += dt;
      this.awayMs = 0;
    } else {
      this.awayMs += dt;
      if (this.awayMs >= s.awayResetMs) this.activeMs = 0;
    }
    return this.activeMs >= s.intervalMs;
  }

  remainingMs(intervalMs) {
    return Math.max(0, intervalMs - this.activeMs);
  }

  reset() {
    this.activeMs = 0;
    this.awayMs = 0;
    this.last = null; // time spent in the break itself does not count
  }
}

module.exports = { BreakTimer };
