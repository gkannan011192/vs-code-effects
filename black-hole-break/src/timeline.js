/*
 * Animation clock. t advances by real elapsed time * speed * direction.
 * Frame rate does not change duration; reverse play is exact.
 */
'use strict';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX_STEP = 0.1; // seconds: guard against a stalled event loop

class Timeline {
  constructor(duration) {
    this.duration = duration;
    this.t = 0;
    this.speed = 1;
    this.direction = 1;
    this.playing = false;
    this.last = null;
  }

  play(direction) {
    if (direction) this.direction = direction;
    this.playing = true;
  }

  pause() { this.playing = false; }

  atStart() { return this.t <= 0; }

  atEnd() { return this.t >= this.duration; }

  /** nowMs: monotonic milliseconds (performance.now()). */
  tick(nowMs) {
    const dt = this.last === null ? 0 : Math.min((nowMs - this.last) / 1000, MAX_STEP);
    this.last = nowMs;
    const from = this.t;
    if (this.playing) {
      this.t = clamp(this.t + dt * this.speed * this.direction, 0, this.duration);
      if ((this.direction > 0 && this.atEnd()) || (this.direction < 0 && this.atStart())) this.playing = false;
    }
    return { from, to: this.t };
  }
}

module.exports = { Timeline };
