'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bh = require('../src/blackhole');

const hole = { line: 20, col: 30 };

test('chunks cover every non-space character once, with vectors to the hole', () => {
  const text = '\tif (n >= MAX_ATTEMPTS) throw e;  ';
  const chunks = bh.lineChunks(text, 25, 3, 4, hole);
  const covered = new Set();
  for (const c of chunks) {
    for (let i = c.start; i < c.end; i++) { assert.ok(!covered.has(i)); covered.add(i); }
    assert.strictEqual(c.vy, 5);
  }
  assert.strictEqual(covered.size, [...text].filter((ch) => ch !== ' ' && ch !== '\t').length);
  // tab expands to 4 columns: first chunk starts at visual column 4
  const first = chunks[0];
  assert.ok(Math.abs(first.vx - 2 * (4 + (first.end - first.start) / 2 - 30)) < 1e-9);
});

test('near chunks fall before far chunks on average', () => {
  const near = bh.lineChunks('x'.repeat(60), 20, 9, 4, hole).filter((c) => Math.abs(c.vx) < 10);
  const far = bh.lineChunks('x'.repeat(60), 60, 9, 4, hole);
  const avg = (a) => a.reduce((s, c) => s + c.delay, 0) / a.length;
  assert.ok(avg(near) < avg(far));
});

test('states: normal at 0, gone before the collapse ends, monotonic', () => {
  for (let line = 0; line < 120; line += 3) {
    for (const c of bh.lineChunks('const value = compute(a, b) + offset;', line, 5, 4, hole)) {
      assert.strictEqual(bh.chunkState(c, 0), bh.NORMAL);
      assert.strictEqual(bh.chunkState(c, bh.TIMING.collapseStart), bh.GONE);
      let prev = -2;
      for (let t = 0; t <= bh.DURATION; t += 0.01) {
        const s = bh.chunkState(c, t);
        const r = s === bh.NORMAL ? -1 : s < bh.DRAIN ? s : s === bh.GONE ? 1e6 : 100 + ((s - bh.DRAIN) % bh.STAGES);
        assert.ok(r >= prev); prev = r;
      }
    }
  }
});

test('hole grows, collapses, then flashes', () => {
  assert.strictEqual(bh.holeLevel(0), null);
  assert.ok(bh.holeLevel(0.3).size > 10);
  assert.ok(bh.holeLevel(3).size >= 20);
  assert.strictEqual(bh.holeLevel(bh.TIMING.collapseEnd), null);
  assert.strictEqual(bh.flashLevel(1), -1);
  assert.ok(bh.flashLevel(bh.TIMING.collapseEnd + 0.05) >= 0);
});

test('styles: every stage type is valid, vectors use ch and lh', () => {
  for (let i = 0; i < bh.TYPE_COUNT; i++) assert.ok(bh.stageOptions(i, 0).textDecoration.startsWith('none'));
  assert.match(bh.vecXOptions(-7).textDecoration, /--bh-x: -3\.5ch/);
  assert.match(bh.vecYOptions(4).textDecoration, /--bh-y: 4lh/);
  assert.strictEqual(bh.diskOptions(30, 20, 3).contentText, '');
  assert.match(bh.shadowOptions(30, 20).textDecoration, /left: calc\(30ch/);
});
