/*
 * Black-Hole Break: a timed eye break for VS Code.
 *
 * After N minutes of active time (inside your schedule), the code in the
 * visible editors goes away with an effect (black hole, wormhole, supernova
 * or dust), the editor stays empty for a short rest, then the animation
 * plays backward and the code comes back.
 */
'use strict';

const vscode = require('vscode');
const { performance } = require('perf_hooks');
const core = require('./src/core');
const { Timeline } = require('./src/timeline');
const { BreakTimer } = require('./src/timer');
const { DustRenderer } = require('./src/renderer');
const { CosmicRenderer } = require('./src/cosmic-renderer');
const cosmic = require('./src/cosmic');

const SECTION = 'blackHoleBreak';
const EXCLUDED_SCHEMES = new Set(['output', 'debug', 'vscode-terminal']);

function readConfig() {
  const c = vscode.workspace.getConfiguration(SECTION);
  let hours = null;
  let hoursError = null;
  try {
    hours = core.parseHours(c.get('activeHours', ''));
  } catch (err) {
    hoursError = err.message;
  }
  return {
    enabled: c.get('enabled', true),
    intervalMs: Math.max(0.05, c.get('intervalMinutes', 10)) * 60000,
    restMs: Math.max(3, c.get('restSeconds', 20)) * 1000,
    hours,
    hoursError,
    days: c.get('activeDays', core.DAY_NAMES),
    idleMs: Math.max(0, c.get('waitForIdleSeconds', 3)) * 1000,
    awayResetMs: Math.max(10, c.get('resetAfterAwaySeconds', 300)) * 1000,
    endOnActivity: c.get('endOnActivity', true),
    message: c.get('message', 'Rest your eyes. Look at something far away.'),
    ghostOpacity: Math.min(0.5, Math.max(0, c.get('ghostOpacity', 0))),
    speed: Math.min(4, Math.max(0.1, c.get('animationSpeed', 1))),
    fps: Math.min(60, Math.max(10, c.get('fps', 30))),
    flash: c.get('flash', true),
    holeScale: Math.min(3, Math.max(0.5, c.get('holeScale', 1))),
    effect: (() => {
      const name = c.get('effect', 'blackHole');
      return name === 'dust' || cosmic.EFFECTS.includes(name) ? name : 'blackHole';
    })()
  };
}

class DustBreak {
  constructor(context) {
    this.context = context;
    this.cfg = readConfig();
    this.timer = new BreakTimer();
    this.renderer = null;
    this.session = null;
    this.frameHandle = null;
    this.pausedUntil = 0;           // wall-clock ms
    this.lastActivity = 0;          // monotonic ms
    this.warnedHours = false;

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = `${SECTION}.menu`;
    this.status.show();

    const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${SECTION}.${id}`, fn));
    cmd('breakNow', () => this.startBreak());
    cmd('endBreak', () => this.endBreak());
    cmd('resetTimer', () => { this.timer.reset(); this.updateStatus(); });
    cmd('pause', () => { this.pausedUntil = Date.now() + 3600000; this.updateStatus(); });
    cmd('resume', () => { this.pausedUntil = 0; this.updateStatus(); });
    cmd('toggle', () => vscode.workspace.getConfiguration(SECTION)
      .update('enabled', !this.cfg.enabled, vscode.ConfigurationTarget.Global));
    cmd('menu', () => this.showMenu());

    const on = (event, fn) => context.subscriptions.push(event(fn, this));
    on(vscode.workspace.onDidChangeConfiguration, (e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      this.cfg = readConfig();
      this.warnedHours = false;
      if (!this.session && this.renderer) { this.renderer.dispose(); this.renderer = null; }
      this.updateStatus();
    });
    on(vscode.workspace.onDidChangeTextDocument, (e) => {
      if (!e.contentChanges.length) return;
      if (!vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) return;
      this.lastActivity = performance.now();
      if (this.session) {
        this.renderer.invalidate(e.document);
        this.session.dirty = true;
        if (this.cfg.endOnActivity) this.endBreak();
      }
    });
    on(vscode.window.onDidChangeTextEditorSelection, (e) => {
      const user = e.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
        e.kind === vscode.TextEditorSelectionChangeKind.Mouse;
      if (!user) return;
      this.lastActivity = performance.now();
      if (this.session && this.cfg.endOnActivity) this.endBreak();
    });
    on(vscode.window.onDidChangeVisibleTextEditors, () => {
      if (!this.session) return;
      this.renderer.sync(this.targetEditors());
      this.session.dirty = true;
    });
    on(vscode.window.onDidChangeTextEditorVisibleRanges, () => {
      if (this.session) this.session.dirty = true;
    });

    this.tickHandle = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  targetEditors() {
    return vscode.window.visibleTextEditors.filter((e) => !EXCLUDED_SCHEMES.has(e.document.uri.scheme));
  }

  inSchedule() {
    if (!this.cfg.enabled || Date.now() < this.pausedUntil) return false;
    if (this.cfg.hoursError && !this.warnedHours) {
      this.warnedHours = true;
      vscode.window.showWarningMessage(`Black-Hole Break: ${this.cfg.hoursError} The schedule is ignored.`);
    }
    return core.inSchedule(new Date(), this.cfg.hours, this.cfg.days);
  }

  // --------------------------------------------------------------- scheduler
  tick() {
    if (this.session) { this.updateStatus(); return; }
    const counting = this.inSchedule();
    const due = this.timer.update(performance.now(), {
      focused: vscode.window.state.focused,
      counting,
      intervalMs: this.cfg.intervalMs,
      awayResetMs: this.cfg.awayResetMs
    });
    const idle = performance.now() - this.lastActivity >= this.cfg.idleMs;
    if (due && idle && vscode.window.state.focused && this.targetEditors().length) this.startBreak();
    this.updateStatus(counting, due);
  }

  // --------------------------------------------------------------- break
  startBreak() {
    if (this.session) return;
    const editors = this.targetEditors();
    if (!editors.length) {
      vscode.window.showInformationMessage('Black-Hole Break: open a file to take a break.');
      return;
    }
    if (this.renderer && this.renderer.kind !== this.cfg.effect) { this.renderer.dispose(); this.renderer = null; }
    if (!this.renderer) {
      const opts = { ghostOpacity: this.cfg.ghostOpacity, flash: this.cfg.flash, holeScale: this.cfg.holeScale };
      this.renderer = this.cfg.effect === 'dust' ? new DustRenderer(opts) : new CosmicRenderer(this.cfg.effect, opts);
    }
    const timeline = new Timeline(this.renderer.duration);
    timeline.speed = this.cfg.speed;
    timeline.play(1);
    this.session = { phase: 'out', timeline, restEnd: 0, dirty: true };
    this.renderer.begin((Math.random() * 4294967296) >>> 0, editors);
    vscode.commands.executeCommand('setContext', `${SECTION}.active`, true);
    this.frameHandle = setInterval(() => this.frame(), Math.round(1000 / this.cfg.fps));
    this.frame();
    this.updateStatus();
  }

  /** End the break early: the dust flies back from wherever it is now. */
  endBreak() {
    const s = this.session;
    if (!s || s.phase === 'in') return;
    s.phase = 'in';
    s.timeline.speed = this.cfg.speed * 1.6;
    s.timeline.play(-1);
    this.renderer.setMessage(null);
    s.dirty = true;
  }

  frame() {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    const { from, to } = s.timeline.tick(now);

    if (s.phase === 'out' && s.timeline.atEnd()) {
      s.phase = 'rest';
      s.restEnd = now + this.cfg.restMs;
      if (typeof this.renderer.setReturning === 'function') this.renderer.setReturning(true); // wormhole: exit mouth
    }
    if (s.phase === 'rest') {
      const left = s.restEnd - now;
      if (left <= 0) {
        s.phase = 'in';
        s.timeline.play(-1);
        this.renderer.setMessage(null);
      } else {
        const msg = this.cfg.message ? `${this.cfg.message}  ${core.fmtCountdown(left)}` : null;
        if (msg !== this.renderer.message) { this.renderer.setMessage(msg); s.dirty = true; }
      }
    }

    if (to !== from || s.dirty) {
      this.renderer.render(to);
      s.dirty = false;
    }

    if (s.phase === 'in' && s.timeline.atStart()) this.finish();
  }

  finish() {
    clearInterval(this.frameHandle);
    this.frameHandle = null;
    this.renderer.clear();
    this.session = null;
    this.timer.reset();
    vscode.commands.executeCommand('setContext', `${SECTION}.active`, false);
    this.updateStatus();
  }

  // --------------------------------------------------------------- UI
  updateStatus(counting = this.inSchedule(), due = false) {
    const st = this.status;
    if (this.session) {
      const s = this.session;
      st.text = s.phase === 'rest'
        ? `$(eye-closed) ${core.fmtCountdown(s.restEnd - performance.now())}`
        : '$(eye-closed) break';
      st.tooltip = 'Eye break. Click or type to end it.';
      return;
    }
    if (!this.cfg.enabled) {
      st.text = '$(eye-closed) off';
      st.tooltip = 'Black-Hole Break is disabled. Click for options.';
    } else if (Date.now() < this.pausedUntil) {
      st.text = `$(debug-pause) ${core.fmtMinutes(this.pausedUntil - Date.now())}`;
      st.tooltip = `Black-Hole Break paused until ${new Date(this.pausedUntil).toLocaleTimeString()}.`;
    } else if (!counting) {
      st.text = '$(eye) off-hours';
      st.tooltip = 'Outside the Black-Hole Break schedule. Click for options.';
    } else if (due) {
      st.text = '$(eye) soon';
      st.tooltip = 'Eye break starts when you stop typing.';
    } else {
      st.text = `$(eye) ${core.fmtMinutes(this.timer.remainingMs(this.cfg.intervalMs))}`;
      st.tooltip = 'Active time to the next eye break. Click for options.';
    }
  }

  async showMenu() {
    const items = [];
    if (this.session) items.push({ label: '$(debug-stop) End break', id: 'endBreak' });
    else items.push({ label: '$(eye-closed) Take a break now', id: 'breakNow' });
    items.push({ label: '$(debug-restart) Reset timer', id: 'resetTimer' });
    if (Date.now() < this.pausedUntil) items.push({ label: '$(debug-continue) Resume', id: 'resume' });
    else items.push({ label: '$(debug-pause) Pause for 1 hour', id: 'pause' });
    items.push({ label: this.cfg.enabled ? '$(circle-slash) Disable' : '$(check) Enable', id: 'toggle' });
    items.push({ label: '$(gear) Settings', id: 'settings' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Black-Hole Break' });
    if (!pick) return;
    if (pick.id === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
    else vscode.commands.executeCommand(`${SECTION}.${pick.id}`);
  }

  dispose() {
    clearInterval(this.tickHandle);
    clearInterval(this.frameHandle);
    if (this.renderer) this.renderer.dispose();
    this.status.dispose();
  }
}

function activate(context) {
  context.subscriptions.push(new DustBreak(context));
}

function deactivate() {}

module.exports = { activate, deactivate };
