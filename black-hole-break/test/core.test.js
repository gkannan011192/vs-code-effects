'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');
const { Timeline } = require('../src/timeline');
const { BreakTimer } = require('../src/timer');

test('lineChunks covers every non-space character exactly once', () => {
  const text = '\tconst  total = items.reduce((a, b) => a + b, 0);   ';
  const chunks = core.lineChunks(text, 12, 99);
  const covered = new Set();
  for (const c of chunks) {
    assert.ok(c.end > c.start && c.end - c.start <= 3);
    for (let i = c.start; i < c.end; i++) {
      assert.ok(!covered.has(i), 'overlap at ' + i);
      assert.ok(text[i] !== ' ' && text[i] !== '\t');
      covered.add(i);
    }
  }
  const nonSpace = [...text].filter((ch) => ch !== ' ' && ch !== '\t').length;
  assert.strictEqual(covered.size, nonSpace);
});

test('lineChunks is deterministic per seed', () => {
  assert.deepStrictEqual(core.lineChunks('foo(bar)', 3, 7), core.lineChunks('foo(bar)', 3, 7));
  assert.notDeepStrictEqual(core.lineChunks('foo(bar)', 3, 7), core.lineChunks('foo(bar)', 3, 8));
});

test('every chunk is normal at t=0 and gone at DURATION', () => {
  for (let line = 0; line < 200; line++) {
    for (const c of core.lineChunks('x'.repeat(120), line, 5)) {
      assert.strictEqual(core.chunkState(c, 0), core.NORMAL);
      assert.strictEqual(core.chunkState(c, core.DURATION), core.GONE);
    }
  }
});

test('chunk state only moves forward as t grows', () => {
  const rank = (s) => (s === core.NORMAL ? -1 : s < core.DRAIN ? s : s === core.GONE ? 1e6 : 100 + ((s - core.DRAIN) % core.STAGES));
  for (const c of core.lineChunks('return someValue + otherValue;', 4, 11)) {
    let prev = -2;
    for (let t = 0; t <= core.DURATION; t += 0.01) {
      const r = rank(core.chunkState(c, t));
      assert.ok(r >= prev, `went back at t=${t}`);
      prev = r;
    }
  }
});

test('type options exist for every type index', () => {
  for (let i = 0; i < core.TYPE_COUNT; i++) {
    const o = core.typeOptions(i, 0);
    assert.ok(o.textDecoration.startsWith('none'));
  }
  assert.strictEqual(core.typeOptions(core.GONE, 0).opacity, '0');
});

test('flash only in the first flashTime seconds', () => {
  assert.strictEqual(core.flashLevel(0), -1);
  assert.strictEqual(core.flashLevel(0.01), 0);
  assert.ok(core.flashLevel(0.3) > 0);
  assert.strictEqual(core.flashLevel(1), -1);
});

test('parseHours and inSchedule', () => {
  assert.strictEqual(core.parseHours(''), null);
  assert.deepStrictEqual(core.parseHours('09:00-12:30, 13:30-18:00'), [[540, 750], [810, 1080]]);
  assert.throws(() => core.parseHours('9-5'));
  const at = (h, m, day = 1) => new Date(2026, 10, 15 + day, h, m); // 2026-11-16 is a Monday
  const work = core.parseHours('09:00-12:30, 13:30-18:00');
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  assert.ok(core.inSchedule(at(10, 0), work, weekdays));
  assert.ok(!core.inSchedule(at(13, 0), work, weekdays));
  assert.ok(!core.inSchedule(at(18, 0), work, weekdays));
  assert.ok(!core.inSchedule(at(10, 0, 6), work, weekdays)); // Sunday
  const night = core.parseHours('22:00-02:00');
  assert.ok(core.inSchedule(at(23, 30), night, null));
  assert.ok(core.inSchedule(at(1, 0), night, null));
  assert.ok(!core.inSchedule(at(12, 0), night, null));
});

test('Timeline is frame-rate independent and reversible', () => {
  const run = (fps) => {
    const tl = new Timeline(10);
    tl.play(1);
    let now = 0;
    tl.tick(now);
    while (now < 2000) { now += 1000 / fps; tl.tick(now); }
    return tl.t;
  };
  assert.ok(Math.abs(run(60) - 2) < 0.02);
  assert.ok(Math.abs(run(12) - 2) < 0.09);
  const tl = new Timeline(3);
  tl.play(1);
  for (let now = 0; now <= 4000; now += 16) tl.tick(now);
  assert.ok(tl.atEnd() && !tl.playing);
  tl.play(-1);
  for (let now = 4000; now <= 8000; now += 16) tl.tick(now);
  assert.ok(tl.atStart());
});

test('BreakTimer counts focused time, resets after being away', () => {
  const t = new BreakTimer();
  const s = { focused: true, counting: true, intervalMs: 10000, awayResetMs: 5000 };
  let now = 0;
  t.update(now, s);
  for (let i = 0; i < 9; i++) assert.strictEqual(t.update((now += 1000), s), false);
  assert.strictEqual(t.update((now += 1000), s), true);
  t.reset();
  t.update((now += 1000), s);
  t.update((now += 3000), s);
  assert.strictEqual(t.activeMs, 3000);
  for (let i = 0; i < 6; i++) t.update((now += 1000), { ...s, focused: false });
  assert.strictEqual(t.activeMs, 0);
  t.update((now += 1000), { ...s, counting: false });
  assert.strictEqual(t.activeMs, 0);
  t.update((now += 3600000), s); // laptop asleep for an hour: capped
  assert.ok(t.activeMs <= 5000);
});
