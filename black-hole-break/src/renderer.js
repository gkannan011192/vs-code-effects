/*
 * Draws the dust with editor decorations.
 *
 * - One decoration type per look (drain levels, flight stages x wind variants,
 *   gone). They are created once; each frame only re-assigns ranges.
 * - Only the visible lines (+ margin) are split into chunks. Lines off screen
 *   are covered by one "gone" range when t > 0.
 * - setDecorations is called only for types whose range set changed.
 */
'use strict';

const vscode = require('vscode');
const core = require('./core');

const MARGIN = 6; // extra lines above / below the viewport

function hashRanges(list) {
  let h = list.length;
  for (const r of list) {
    h = (Math.imul(h, 31) + r.start.line * 131 + r.start.character) | 0;
    h = (Math.imul(h, 31) + r.end.line * 17 + r.end.character) | 0;
  }
  return h;
}

class DustRenderer {
  /** @param {{ghostOpacity: number, flash: boolean}} opts */
  constructor(opts) {
    this.kind = 'dust';
    this.opts = opts;
    this.seed = 1;
    this.entries = new Map(); // TextEditor -> { cache, last, lastFlash, lastMsg }
    this.types = [];
    for (let i = 0; i < core.TYPE_COUNT; i++) {
      this.types.push(vscode.window.createTextEditorDecorationType(core.typeOptions(i, opts.ghostOpacity)));
    }
    this.flashTypes = [];
    for (let i = 0; i < core.FLASH; i++) {
      this.flashTypes.push(vscode.window.createTextEditorDecorationType(core.flashOptions(i)));
    }
    this.msgType = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 6ch'
      }
    });
    this.message = null;
  }

  get duration() { return core.DURATION; }

  begin(seed, editors) {
    this.seed = seed;
    this.entries.clear();
    this.message = null;
    editors.forEach((e) => this.add(e));
  }

  add(editor) {
    if (this.entries.has(editor)) return;
    this.entries.set(editor, {
      cache: new Map(),
      last: new Array(core.TYPE_COUNT).fill(0),
      lastFlash: -2,
      lastMsg: null
    });
  }

  /** Keep only editors that are still visible; add new ones. */
  sync(editors) {
    for (const ed of [...this.entries.keys()]) if (!editors.includes(ed)) this.entries.delete(ed);
    editors.forEach((e) => this.add(e));
  }

  invalidate(document) {
    for (const [ed, entry] of this.entries) if (ed.document === document) entry.cache.clear();
  }

  setMessage(text) {
    this.message = text;
  }

  render(t) {
    for (const [ed, entry] of this.entries) {
      try {
        this._renderEditor(ed, entry, t);
      } catch (err) {
        // editor closed in the middle of a frame
        this.entries.delete(ed);
      }
    }
  }

  _renderEditor(ed, entry, t) {
    const doc = ed.document;
    const vr = ed.visibleRanges;
    if (!vr.length || doc.lineCount === 0) return;
    const last = doc.lineCount - 1;
    const lo = Math.max(0, vr[0].start.line - MARGIN);
    const hi = Math.min(last, vr[vr.length - 1].end.line + MARGIN);

    const buckets = Array.from({ length: core.TYPE_COUNT }, () => []);
    for (let line = lo; line <= hi; line++) {
      let chunks = entry.cache.get(line);
      if (!chunks) {
        chunks = core.lineChunks(doc.lineAt(line).text, line, this.seed);
        entry.cache.set(line, chunks);
      }
      for (const c of chunks) {
        const s = core.chunkState(c, t);
        if (s >= 0) buckets[s].push(new vscode.Range(line, c.start, line, c.end));
      }
    }
    if (t > 0) {
      if (lo > 0) buckets[core.GONE].push(new vscode.Range(0, 0, lo - 1, doc.lineAt(lo - 1).text.length));
      if (hi < last) buckets[core.GONE].push(new vscode.Range(hi + 1, 0, last, doc.lineAt(last).text.length));
    }

    for (let i = 0; i < core.TYPE_COUNT; i++) {
      const h = hashRanges(buckets[i]);
      if (h !== entry.last[i]) {
        ed.setDecorations(this.types[i], buckets[i]);
        entry.last[i] = h;
      }
    }

    const level = this.opts.flash ? core.flashLevel(t) : -1;
    if (level !== entry.lastFlash) {
      const whole = [new vscode.Range(lo, 0, hi, 0)];
      this.flashTypes.forEach((type, i) => ed.setDecorations(type, i === level ? whole : []));
      entry.lastFlash = level;
    }

    const msgKey = this.message ? `${this.message}@${vr[0].start.line}` : null;
    if (msgKey !== entry.lastMsg) {
      if (this.message) {
        const mid = Math.floor((vr[0].start.line + vr[vr.length - 1].end.line) / 2);
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

  /** Remove every decoration from every tracked editor. */
  clear() {
    for (const ed of this.entries.keys()) {
      try {
        this.types.forEach((type) => ed.setDecorations(type, []));
        this.flashTypes.forEach((type) => ed.setDecorations(type, []));
        ed.setDecorations(this.msgType, []);
      } catch (err) { /* editor gone */ }
    }
    this.entries.clear();
  }

  dispose() {
    this.clear();
    this.types.forEach((d) => d.dispose());
    this.flashTypes.forEach((d) => d.dispose());
    this.msgType.dispose();
  }
}

module.exports = { DustRenderer };
