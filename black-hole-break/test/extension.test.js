'use strict';
/*
 * Runs extension.js against a small fake `vscode` module: one break from
 * start to finish, plus an early end. Checks decorations and cleanup.
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// ------------------------------------------------------------ fake vscode
function makeVscode(lines) {
  class Position { constructor(l, c) { this.line = l; this.character = c; } }
  class Range {
    constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  const emitters = {};
  const event = (name) => (fn) => { (emitters[name] = emitters[name] || []).push(fn); return { dispose() {} }; };
  const fire = (name, e) => (emitters[name] || []).forEach((fn) => fn(e));

  const document = {
    uri: { scheme: 'file' },
    lineCount: lines.length,
    lineAt: (i) => ({ text: lines[i] })
  };
  const decorations = new Map(); // type -> ranges
  const editor = {
    document,
    options: { tabSize: 4 },
    visibleRanges: [new Range(0, 0, Math.min(39, lines.length - 1), 0)],
    setDecorations(type, ranges) { decorations.set(type, ranges); }
  };
  let typeId = 0;
  const config = {};
  const commands = {};
  const vscode = {
    Range, Position,
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    window: {
      state: { focused: true },
      visibleTextEditors: [editor],
      createTextEditorDecorationType: (opts) => ({ id: ++typeId, opts, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '' }),
      showInformationMessage() {}, showWarningMessage() {}, showQuickPick: async () => undefined,
      onDidChangeTextEditorSelection: event('selection'),
      onDidChangeVisibleTextEditors: event('visible'),
      onDidChangeTextEditorVisibleRanges: event('ranges')
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: event('config'),
      onDidChangeTextDocument: event('docChange')
    },
    commands: {
      registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id, ...args) => (commands[id] ? commands[id](...args) : undefined)
    }
  };
  return { vscode, editor, decorations, config, commands, fire, document };
}

function loadExtension(fake) {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
  };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake.vscode };
  const root = path.join(__dirname, '..');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root) && !k.includes('test')) delete require.cache[k];
  const ext = require('../extension.js');
  Module._resolveFilename = origResolve;
  return ext;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINES = Array.from({ length: 120 }, (_, i) => `    const value${i} = compute(${i}) + offset; // line ${i}`);

function totalRanges(decorations, filter = () => true) {
  let n = 0;
  for (const [type, ranges] of decorations) if (filter(type)) n += ranges.length;
  return n;
}

test('a full break dissolves, rests, reassembles and cleans up', async () => {
  const fake = makeVscode(LINES);
  Object.assign(fake.config, { effect: 'dust', restSeconds: 3, animationSpeed: 4, fps: 60, message: 'Rest' });
  const ext = loadExtension(fake);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);

  await fake.commands['blackHoleBreak.breakNow']();
  await sleep(450); // mid animation at 4x speed
  const flying = totalRanges(fake.decorations, (t) => t.opts.textDecoration && t.opts.textDecoration.includes('translate('));
  assert.ok(flying > 0, 'some chunks are in flight');

  await sleep(800); // animation done (3.6 s / 4 = 0.9 s): rest phase
  const gone = [...fake.decorations].find(([t]) => t.opts.opacity === '0' && !t.opts.textDecoration.includes('translate('));
  assert.ok(gone && gone[1].length > 0, 'code is hidden during the rest');
  const msg = [...fake.decorations].find(([t]) => t.opts.before);
  assert.ok(msg && msg[1].length === 1 && msg[1][0].renderOptions.before.contentText.startsWith('Rest'));

  await sleep(3200); // rest over, reassemble at 4x
  await sleep(1100);
  assert.strictEqual(totalRanges(fake.decorations), 0, 'all decorations removed after the break');

  ctx.subscriptions.forEach((d) => d.dispose());
});

test('typing ends the break early', async () => {
  const fake = makeVscode(LINES);
  Object.assign(fake.config, { effect: 'dust', restSeconds: 30, animationSpeed: 4, fps: 60 });
  const ext = loadExtension(fake);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);

  await fake.commands['blackHoleBreak.breakNow']();
  await sleep(1100); // in rest
  assert.ok(totalRanges(fake.decorations) > 0);
  fake.fire('selection', { kind: fake.vscode.TextEditorSelectionChangeKind.Keyboard });
  await sleep(1000); // reverse at 4 * 1.6 speed
  assert.strictEqual(totalRanges(fake.decorations), 0);
  ctx.subscriptions.forEach((d) => d.dispose());
});

test('the timer starts a break by itself, only inside the schedule and after idle', async () => {
  const fake = makeVscode(LINES);
  const now = new Date();
  const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // a schedule window that excludes "now"
  const later = new Date(now.getTime() + 2 * 3600000);
  const later2 = new Date(now.getTime() + 3 * 3600000);
  Object.assign(fake.config, { intervalMinutes: 0.05, waitForIdleSeconds: 0, restSeconds: 30, activeHours: `${hh(later)}-${hh(later2)}` });
  let ext = loadExtension(fake);
  let ctx = { subscriptions: [] };
  ext.activate(ctx);
  await sleep(4500);
  assert.strictEqual(totalRanges(fake.decorations), 0, 'no break outside the schedule');
  ctx.subscriptions.forEach((d) => d.dispose());

  const fake2 = makeVscode(LINES);
  Object.assign(fake2.config, { intervalMinutes: 0.05, waitForIdleSeconds: 0, restSeconds: 30, activeHours: '' });
  ext = loadExtension(fake2);
  ctx = { subscriptions: [] };
  ext.activate(ctx);
  await sleep(4500);
  assert.ok(totalRanges(fake2.decorations) > 0, 'break started after 3 s of active time');
  ctx.subscriptions.forEach((d) => d.dispose());
});

test('black hole: chunks get vectors, spiral in, hole shows, all cleaned up', async () => {
  const fake = makeVscode(LINES);
  Object.assign(fake.config, { restSeconds: 3, animationSpeed: 4, fps: 60, message: 'Rest' }); // default effect
  const ext = loadExtension(fake);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);

  await fake.commands['blackHoleBreak.breakNow']();
  await sleep(400); // t ~ 1.6 s on the timeline
  const vec = totalRanges(fake.decorations, (t) => /--bh-[xy]/.test(t.opts.textDecoration || ''));
  assert.ok(vec > 0, 'vector decorations set');
  const falling = totalRanges(fake.decorations, (t) => (t.opts.textDecoration || '').includes('rotate:'));
  assert.ok(falling > 0, 'some chunks spiral in');
  const hole = [...fake.decorations].filter(([t, r]) => (t.opts.before || t.opts.after) && r.length && !(t.opts.before && t.opts.before.margin));
  assert.strictEqual(hole.length, 2, 'disk + event horizon are shown');

  await sleep(1100); // past 5 s / 4: rest
  const gone = [...fake.decorations].find(([t]) => t.opts.opacity === '0');
  assert.ok(gone && gone[1].length > 0, 'code hidden during the rest');
  const holeAtRest = [...fake.decorations].filter(([t, r]) => (t.opts.before || t.opts.after) && r.length && !(t.opts.before && t.opts.before.margin));
  assert.strictEqual(holeAtRest.length, 0, 'hole has collapsed');

  await sleep(3200 + 1500); // rest over, white hole at 4x
  assert.strictEqual(totalRanges(fake.decorations), 0, 'all decorations removed after the break');
  ctx.subscriptions.forEach((d) => d.dispose());
});

const overlayRanges = (decorations) => [...decorations].filter(([t, r]) =>
  (t.opts.before || t.opts.after) && r.length && !(t.opts.before && t.opts.before.margin));

test('wormhole: in through mouth A, rest, out of mouth B, cleaned up', async () => {
  const fake = makeVscode(LINES);
  Object.assign(fake.config, { effect: 'wormhole', restSeconds: 3, animationSpeed: 4, fps: 60, message: 'Rest' });
  const ext = loadExtension(fake);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);

  await fake.commands['blackHoleBreak.breakNow']();
  await sleep(400);
  const inbound = overlayRanges(fake.decorations);
  assert.strictEqual(inbound.length, 2, 'swirl + throat of mouth A');
  const lineA = inbound[0][1][0].start.line;
  assert.ok(totalRanges(fake.decorations, (t) => /rgba\(120,190,255/.test(t.opts.textDecoration || '')) > 0, 'blue-shifted grains');

  await sleep(1100 + 3000 + 300); // rest done, about 1.2 s of the return at 4x
  const outbound = overlayRanges(fake.decorations);
  assert.strictEqual(outbound.length, 2, 'swirl + throat of mouth B');
  assert.notStrictEqual(outbound[0][1][0].start.line, lineA, 'the exit mouth is on another line');

  await sleep(1500);
  assert.strictEqual(totalRanges(fake.decorations), 0, 'all decorations removed');
  ctx.subscriptions.forEach((d) => d.dispose());
});

test('supernova: core, blast outward, nebula, rest, implode back, cleaned up', async () => {
  const fake = makeVscode(LINES);
  Object.assign(fake.config, { effect: 'supernova', restSeconds: 3, animationSpeed: 4, fps: 60, message: 'Rest' });
  const ext = loadExtension(fake);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);

  await fake.commands['blackHoleBreak.breakNow']();
  await sleep(300); // t ~ 1.2 s: after the explosion
  const keys = overlayRanges(fake.decorations).map(([t]) => t.opts.before || t.opts.after);
  assert.ok(keys.length >= 2, 'shock ring / nebula / star shown');
  assert.ok(totalRanges(fake.decorations, (t) => /brightness\(2/.test(t.opts.textDecoration || '')) > 0, 'white-hot grains');

  await sleep(900); // past 4.05 s / 4: rest
  assert.strictEqual(overlayRanges(fake.decorations).length, 0, 'empty editor during the rest');
  const gone = [...fake.decorations].find(([t]) => t.opts.opacity === '0');
  assert.ok(gone && gone[1].length > 0);

  await sleep(3000 + 1400);
  assert.strictEqual(totalRanges(fake.decorations), 0, 'all decorations removed');
  ctx.subscriptions.forEach((d) => d.dispose());
});
