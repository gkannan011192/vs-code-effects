/*
 * Renderer for the cosmic effects (black hole, wormhole, supernova).
 * The effect itself is a pure spec from ./cosmic.js; this file only turns
 * the spec into VS Code decorations.
 *
 * Per grain, three inline decorations stack on the same range:
 *   vecX type  -> --bh-x   (one type per half-column offset, made on demand)
 *   vecY type  -> --bh-y   (one type per line offset, made on demand)
 *   stage type -> transform that reads --bh-x / --bh-y
 * Vector decorations change only when the visible window or the anchor
 * changes. Each frame re-assigns only the stage types and the overlays.
 * Overlay types (hole, ring, nebula, ...) are made on demand per break and
 * disposed after it.
 */
'use strict';

const vscode = require('vscode');
const bh = require('./blackhole');
const cosmic = require('./cosmic');

const MARGIN = 6;

function hashRanges(list) {
  let h = list.length;
  for (const r of list) {
    h = (Math.imul(h, 31) + r.start.line * 131 + r.start.character) | 0;
    h = (Math.imul(h, 31) + r.end.line * 17 + r.end.character) | 0;
  }
  return h;
}

class CosmicRenderer {
  /**
   * @param {string} effect  'blackHole' | 'wormhole' | 'supernova'
   * @param {{ghostOpacity: number, flash: boolean, holeScale?: number}} opts
   */
  constructor(effect, opts) {
    this.spec = cosmic.getSpec(effect);
    this.kind = this.spec.name;
    this.opts = opts;
    this.seed = 1;
    this.returning = false;
    this.entries = new Map();
    this.message = null;
    const make = (o) => vscode.window.createTextEditorDecorationType(o);
    this.stageTypes = [];
    for (let i = 0; i < this.spec.TYPE_COUNT; i++) this.stageTypes.push(make(this.spec.stageOptions(i, opts.ghostOpacity)));
    this.flashTypes = [];
    for (let i = 0; i < this.spec.FLASH; i++) this.flashTypes.push(make(this.spec.flashOptions(i)));
    this.msgType = make({
      before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 6ch' }
    });
    this.vecTypes = new Map();      // 'x12' / 'y-3' -> type (kept for the session)
    this.overlayTypes = new Map();  // per break, disposed in clear()
  }

  get duration() { return this.spec.DURATION; }

  begin(seed, editors) {
    this.seed = seed;
    this.returning = false;
    this.entries.clear();
    this.message = null;
    editors.forEach((e) => this.add(e));
  }

  /**
   * Called when the code is fully gone (rest starts). Effects with an exit
   * (wormhole) bring the code back from another anchor. Nothing is visible
   * at that moment, so the vector switch cannot be seen.
   */
  setReturning(on) {
    if (this.returning === on) return;
    this.returning = on;
    for (const entry of this.entries.values()) entry.winKey = '';
  }

  add(editor) {
    if (this.entries.has(editor)) return;
    this.entries.set(editor, {
      anchors: null,
      cache: new Map(),             // `${anchorIndex}:${line}` -> chunks
      winKey: '',
      vecHash: new Map(),           // vec type -> hash of ranges set
      last: new Array(this.spec.TYPE_COUNT).fill(0),
      overlays: new Map(),          // key -> type currently set
      lastFlash: -2,
      lastMsg: null
    });
  }

  sync(editors) {
    for (const ed of [...this.entries.keys()]) if (!editors.includes(ed)) this.entries.delete(ed);
    editors.forEach((e) => this.add(e));
  }

  invalidate(document) {
    for (const [ed, entry] of this.entries) {
      if (ed.document === document) { entry.cache.clear(); entry.winKey = ''; }
    }
  }

  setMessage(text) { this.message = text; }

  _vecType(key, opts) {
    let t = this.vecTypes.get(key);
    if (!t) { t = vscode.window.createTextEditorDecorationType(opts); this.vecTypes.set(key, t); }
    return t;
  }

  _overlayType(key, opts) {
    let t = this.overlayTypes.get(key);
    if (!t) { t = vscode.window.createTextEditorDecorationType(opts); this.overlayTypes.set(key, t); }
    return t;
  }

  render(t) {
    for (const [ed, entry] of this.entries) {
      try {
        this._renderEditor(ed, entry, t);
      } catch (err) {
        this.entries.delete(ed);
      }
    }
  }

  _renderEditor(ed, entry, t) {
    const spec = this.spec;
    const doc = ed.document;
    const vr = ed.visibleRanges;
    if (!vr.length || doc.lineCount === 0) return;
    const last = doc.lineCount - 1;
    const tab = typeof ed.options.tabSize === 'number' ? ed.options.tabSize : 4;
    const first = vr[0].start.line;
    const end = vr[vr.length - 1].end.line;
    const lo = Math.max(0, first - MARGIN);
    const hi = Math.min(last, end + MARGIN);

    if (!entry.anchors) {
      const texts = [];
      for (let l = first; l <= Math.min(end, last); l++) texts.push(doc.lineAt(l).text);
      entry.anchors = spec.anchors(texts, first, tab, this.opts.holeScale || 1)
        .map((a) => Object.assign({}, a, { line: Math.min(a.line, last) }));
    }
    const idx = Math.min(spec.anchorIndex(this.returning), entry.anchors.length - 1);
    const anchor = entry.anchors[idx];

    // grains for the window, relative to the active anchor
    const lines = [];
    for (let line = lo; line <= hi; line++) {
      const key = `${idx}:${line}`;
      let chunks = entry.cache.get(key);
      if (!chunks) {
        chunks = bh.lineChunks(doc.lineAt(line).text, line, this.seed, tab, anchor, spec.profile);
        entry.cache.set(key, chunks);
      }
      lines.push([line, chunks]);
    }

    // vector decorations: only when the window or the anchor changes
    const winKey = `${idx}|${lo}:${hi}`;
    if (winKey !== entry.winKey) {
      const groups = new Map();
      const push = (key, opts, range) => {
        let g = groups.get(key);
        if (!g) { g = { type: this._vecType(key, opts), ranges: [] }; groups.set(key, g); }
        g.ranges.push(range);
      };
      for (const [line, chunks] of lines) {
        for (const c of chunks) {
          const r = new vscode.Range(line, c.start, line, c.end);
          push('x' + c.vx, bh.vecXOptions(c.vx), r);
          push('y' + c.vy, bh.vecYOptions(c.vy), r);
        }
      }
      const next = new Map();
      for (const g of groups.values()) next.set(g.type, g.ranges);
      for (const [type] of entry.vecHash) if (!next.has(type)) { ed.setDecorations(type, []); entry.vecHash.delete(type); }
      for (const [type, ranges] of next) {
        const h = hashRanges(ranges);
        if (entry.vecHash.get(type) !== h) { ed.setDecorations(type, ranges); entry.vecHash.set(type, h); }
      }
      entry.winKey = winKey;
    }

    // stage decorations: every frame
    const buckets = Array.from({ length: spec.TYPE_COUNT }, () => []);
    for (const [line, chunks] of lines) {
      for (const c of chunks) {
        const s = bh.chunkState(c, t);
        if (s >= 0) buckets[s].push(new vscode.Range(line, c.start, line, c.end));
      }
    }
    if (t > 0) {
      if (lo > 0) buckets[spec.GONE].push(new vscode.Range(0, 0, lo - 1, doc.lineAt(lo - 1).text.length));
      if (hi < last) buckets[spec.GONE].push(new vscode.Range(hi + 1, 0, last, doc.lineAt(last).text.length));
    }
    for (let i = 0; i < spec.TYPE_COUNT; i++) {
      const h = hashRanges(buckets[i]);
      if (h !== entry.last[i]) { ed.setDecorations(this.stageTypes[i], buckets[i]); entry.last[i] = h; }
    }

    // overlays (hole, mouths, core, shock ring, nebula, ...)
    const wanted = new Map();
    for (const o of spec.overlays(t, entry.anchors, idx)) wanted.set(o.key, o);
    for (const [key, type] of entry.overlays) {
      if (!wanted.has(key)) { ed.setDecorations(type, []); entry.overlays.delete(key); }
    }
    for (const [key, o] of wanted) {
      if (entry.overlays.has(key)) continue;
      const type = this._overlayType(key, o.opts);
      const line = Math.min(o.line, last);
      ed.setDecorations(type, [new vscode.Range(line, 0, line, 0)]);
      entry.overlays.set(key, type);
    }

    // flash
    const level = this.opts.flash ? spec.flashLevel(t) : -1;
    if (level !== entry.lastFlash) {
      const whole = [new vscode.Range(lo, 0, hi, 0)];
      this.flashTypes.forEach((type, i) => ed.setDecorations(type, i === level ? whole : []));
      entry.lastFlash = level;
    }

    // rest message
    const msgKey = this.message ? `${this.message}@${first}` : null;
    if (msgKey !== entry.lastMsg) {
      if (this.message) {
        const mid = Math.min(last, Math.floor((first + end) / 2));
        ed.setDecorations(this.msgType, [{
          range: new vscode.Range(mid, 0, mid, 0),
          renderOptions: { before: { contentText: this.message } }
        }]);
      } else {
        ed.setDecorations(this.msgType, []);
      }
      entry.lastMsg = msgKey;
    }
  }

  clear() {
    for (const [ed, entry] of this.entries) {
      try {
        this.stageTypes.forEach((type) => ed.setDecorations(type, []));
        this.flashTypes.forEach((type) => ed.setDecorations(type, []));
        for (const [type] of entry.vecHash) ed.setDecorations(type, []);
        for (const type of entry.overlays.values()) ed.setDecorations(type, []);
        ed.setDecorations(this.msgType, []);
      } catch (err) { /* editor gone */ }
    }
    this.entries.clear();
    this.overlayTypes.forEach((type) => type.dispose());
    this.overlayTypes.clear();
  }

  dispose() {
    this.clear();
    this.stageTypes.forEach((d) => d.dispose());
    this.flashTypes.forEach((d) => d.dispose());
    this.vecTypes.forEach((d) => d.dispose());
    this.vecTypes.clear();
    this.msgType.dispose();
  }
}

module.exports = { CosmicRenderer };
