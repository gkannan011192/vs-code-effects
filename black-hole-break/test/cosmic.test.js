'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bh = require('../src/blackhole');
const cosmic = require('../src/cosmic');

const LINES = Array.from({ length: 40 }, (_, i) => `    const value${i} = compute(${i}) + offset; // line ${i}`);

for (const name of cosmic.EFFECTS) {
  const spec = cosmic.SPECS[name];

  test(`${name}: stage types are valid`, () => {
    assert.strictEqual(spec.name, name);
    for (let i = 0; i < spec.TYPE_COUNT; i++) {
      const o = spec.stageOptions(i, 0);
      assert.ok(o.textDecoration.startsWith('none'), `type ${i}`);
    }
    for (let l = 0; l < spec.FLASH; l++) assert.ok(spec.flashOptions(l).isWholeLine);
  });

  test(`${name}: grains are normal at 0 and gone before the end`, () => {
    const anchors = spec.anchors(LINES, 0, 4, 1);
    for (const a of anchors) {
      for (let line = 0; line < 40; line += 3) {
        for (const c of bh.lineChunks(LINES[line], line, 7, 4, a, spec.profile)) {
          assert.strictEqual(bh.chunkState(c, 0), bh.NORMAL);
          assert.strictEqual(bh.chunkState(c, spec.DURATION), bh.GONE);
        }
      }
    }
  });

  test(`${name}: nothing on screen at t=0 and during the rest`, () => {
    const anchors = spec.anchors(LINES, 0, 4, 1);
    for (const idx of [0, anchors.length - 1]) {
      assert.deepStrictEqual(spec.overlays(0, anchors, idx), []);
      assert.deepStrictEqual(spec.overlays(spec.DURATION, anchors, idx), []);
    }
    assert.strictEqual(spec.flashLevel(0), -1);
    assert.strictEqual(spec.flashLevel(spec.DURATION), -1);
  });

  test(`${name}: overlays are empty attachments with stable keys`, () => {
    const anchors = spec.anchors(LINES, 0, 4, 1);
    let seen = 0;
    for (let t = 0.05; t < spec.DURATION; t += 0.05) {
      const list = spec.overlays(t, anchors, 0);
      const again = spec.overlays(t, anchors, 0);
      assert.deepStrictEqual(list.map((o) => o.key), again.map((o) => o.key));   // pure f(t)
      for (const o of list) {
        const att = o.opts.before || o.opts.after;
        assert.strictEqual(att.contentText, '');
        assert.match(att.textDecoration, /position: absolute/);
        assert.ok(Number.isInteger(o.line));
        seen++;
      }
    }
    assert.ok(seen > 0);
  });
}

test('wormhole: two mouths, far apart; return uses mouth B', () => {
  const spec = cosmic.SPECS.wormhole;
  const [a, b] = spec.anchors(LINES, 0, 4, 1);
  assert.ok(b.col > a.col && b.line > a.line);
  assert.strictEqual(spec.anchorIndex(false), 0);
  assert.strictEqual(spec.anchorIndex(true), 1);
  const keysA = spec.overlays(1, [a, b], 0).map((o) => o.key).join();
  const keysB = spec.overlays(1, [a, b], 1).map((o) => o.key).join();
  assert.match(keysA, /\|A\|/);
  assert.match(keysB, /\|B\|/);
  assert.match(spec.stageOptions(bh.DRAIN + 8, 0).textDecoration, /rgba\(120,190,255/);  // blue shift
});

test('supernova: grains near the core get a minimum push outward', () => {
  const spec = cosmic.SPECS.supernova;
  const [core] = spec.anchors(LINES, 0, 4, 1);
  const chunks = bh.lineChunks(LINES[core.line], core.line, 3, 4, core, spec.profile);
  for (const c of chunks) {
    const len = Math.hypot(c.vx * 0.5, c.vy * bh.LINE_IN_COLUMNS);
    assert.ok(len >= spec.profile.minDist - 1.5, `|v| = ${len}`);
  }
  // timing still uses the true distance: grains on the core line explode first
  const far = bh.lineChunks(LINES[0], 0, 3, 4, core, spec.profile);
  const avg = (l) => l.reduce((s, c) => s + c.delay, 0) / l.length;
  assert.ok(avg(chunks) < avg(far));
  // the explosion moves grains outward: stage translate factors are positive
  assert.match(spec.stageOptions(bh.DRAIN + 10, 0).textDecoration, /translate: calc\(\d/);
});

test('supernova: core, then shock ring + star, then nebula', () => {
  const spec = cosmic.SPECS.supernova;
  const anchors = spec.anchors(LINES, 0, 4, 1);
  const kinds = (t) => spec.overlays(t, anchors, 0).map((o) => o.key.split('|')[0]).sort().join(',');
  assert.strictEqual(kinds(0.4), 'sn-c');
  assert.strictEqual(kinds(1.0), 'sn-n,sn-p,sn-r');
  assert.strictEqual(kinds(3.0), 'sn-n,sn-p');
  assert.ok(spec.flashLevel(cosmic.SN.explode + 0.05) >= 0);
});
