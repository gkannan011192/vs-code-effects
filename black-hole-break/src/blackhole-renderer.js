/*
 * Black hole renderer (VS Code decorations).
 *
 * Per chunk, three inline decorations stack on the same range:
 *   vecX type  -> --bh-x   (one type per half-column offset, made on demand)
 *   vecY type  -> --bh-y   (one type per line offset, made on demand)
 *   stage type -> spiral transform that reads --bh-x / --bh-y
 * Vector decorations change only when the visible window changes; each frame
 * only re-assigns the stage types. The hole is two empty attachments
 * (disk + event horizon) at the hole line; their types are made on demand
 * per (column, size, angle) and disposed after the break.
 */
'use strict';

const vscode = require('vscode');
const bh = require('./blackhole');

const MARGIN = 6;

function hashRanges(list) {
  let h = list.length;
  for (const r of list) {
    h = (Math.imul(h, 31) + r.start.line * 131 + r.start.character) | 0;
    h = (Math.imul(h, 31) + r.end.line * 17 + r.end.character) | 0;
  }
  return h;
}

class BlackHoleRenderer {
  /** @param {{ghostOpacity: number, flash: boolean, holeScale?: number}} opts */
  constructor(opts) {
    this.kind = 'blackHole';
    this.opts = opts;
    this.seed = 1;
    this.entries = new Map();
    this.message = null;
    this.stageTypes = [];
    for (let i = 0; i < bh.TYPE_COUNT; i++) {
      this.stageTypes.push(vscode.window.createTextEditorDecorationType(bh.stageOptions(i, opts.ghostOpacity)));
    }
    this.flashTypes = [];
    for (let i = 0; i < bh.FLASH; i++) this.flashTypes.push(vscode.window.createTextEditorDecorationType(bh.flashOptions(i)));
    this.msgType = vscode.window.createTextEditorDecorationType({
      before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 6ch' }
    });
    this.vecTypes = new Map();   // 'x12' / 'y-3' -> type (kept for the session)
    this.holeTypes = new Map();  // per-break, disposed in clear()
  }

  get duration() { return bh.DURATION; }

  begin(seed, editors) {
    this.seed = seed;
    this.entries.clear();
    this.message = null;
    editors.forEach((e) => this.add(e));
  }

  add(editor) {
    if (this.entries.has(editor)) return;
    this.entries.set(editor, {
      hole: null,
      cache: new Map(),
      winKey: '',
      vecHash: new Map(),        // vec type -> hash of ranges set
      last: new Array(bh.TYPE_COUNT).fill(0),
      holeKey: null,
      holeSet: [],               // hole types currently set on this editor
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

  _holeType(key, make) {
    let t = this.holeTypes.get(key);
    if (!t) { t = vscode.window.createTextEditorDecorationType(make()); this.holeTypes.set(key, t); }
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
    const doc = ed.document;
    const vr = ed.visibleRanges;
    if (!vr.length || doc.lineCount === 0) return;
    const last = doc.lineCount - 1;
    const tab = typeof ed.options.tabSize === 'number' ? ed.options.tabSize : 4;
    const first = vr[0].start.line;
    const end = vr[vr.length - 1].end.line;
    const lo = Math.max(0, first - MARGIN);
    const hi = Math.min(last, end + MARGIN);

    if (!entry.hole) {
      const texts = [];
      for (let l = first; l <= Math.min(end, last); l++) texts.push(doc.lineAt(l).text);
      entry.hole = bh.pickHole(texts, first, tab, this.opts.holeScale || 1);
      entry.hole.line = Math.min(entry.hole.line, last);
    }
    const hole = entry.hole;

    // chunks for the window
    const lines = [];
    for (let line = lo; line <= hi; line++) {
      let chunks = entry.cache.get(line);
      if (!chunks) {
        chunks = bh.lineChunks(doc.lineAt(line).text, line, this.seed, tab, hole);
        entry.cache.set(line, chunks);
      }
      lines.push([line, chunks]);
    }

    // vector decorations: only when the window changes
    const winKey = `${lo}:${hi}`;
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
    const buckets = Array.from({ length: bh.TYPE_COUNT }, () => []);
    for (const [line, chunks] of lines) {
      for (const c of chunks) {
        const s = bh.chunkState(c, t);
        if (s >= 0) buckets[s].push(new vscode.Range(line, c.start, line, c.end));
      }
    }
    if (t > 0) {
      if (lo > 0) buckets[bh.GONE].push(new vscode.Range(0, 0, lo - 1, doc.lineAt(lo - 1).text.length));
      if (hi < last) buckets[bh.GONE].push(new vscode.Range(hi + 1, 0, last, doc.lineAt(last).text.length));
    }
    for (let i = 0; i < bh.TYPE_COUNT; i++) {
      const h = hashRanges(buckets[i]);
      if (h !== entry.last[i]) { ed.setDecorations(this.stageTypes[i], buckets[i]); entry.last[i] = h; }
    }

    // the hole
    const lvl = bh.holeLevel(t);
    const holeKey = lvl ? `${lvl.size}|${lvl.angle}` : null;
    if (holeKey !== entry.holeKey) {
      entry.holeSet.forEach((type) => ed.setDecorations(type, []));
      entry.holeSet = [];
      if (lvl) {
        const at = [new vscode.Range(hole.line, 0, hole.line, 0)];
        const disk = this._holeType(`d${hole.col}|${hole.radius}|${holeKey}`, () => ({ before: bh.diskOptions(hole.col, lvl.size, lvl.angle, hole.radius) }));
        const shadow = this._holeType(`s${hole.col}|${hole.radius}|${lvl.size}`, () => ({ after: bh.shadowOptions(hole.col, lvl.size, hole.radius) }));
        ed.setDecorations(disk, at);
        ed.setDecorations(shadow, at);
        entry.holeSet = [disk, shadow];
      }
      entry.holeKey = holeKey;
    }

    // flash at the collapse
    const level = this.opts.flash ? bh.flashLevel(t) : -1;
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
        entry.holeSet.forEach((type) => ed.setDecorations(type, []));
        ed.setDecorations(this.msgType, []);
      } catch (err) { /* editor gone */ }
    }
    this.entries.clear();
    this.holeTypes.forEach((type) => type.dispose());
    this.holeTypes.clear();
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

module.exports = { BlackHoleRenderer };
