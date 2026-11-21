# Black-Hole Break

A timed eye break for VS Code.

After a set time of active work, the code in your editors falls into a black hole (default) or turns to dust.
The editor stays empty for a short rest. Then the animation plays backward and the code comes back.

There is no key to push. The timer and the time filter start each break.

Previews of the two effects: `media/preview-blackhole.gif` and `media/preview-dust.gif` in the [repository](https://github.com/gkannan011192/vs-code-effects).

## Install

Build from source. Full instructions: [repository README](../README.md#set-up).

Short form (macOS / Linux, needs Node.js 18+ and the `code` command):

```
git clone https://github.com/gkannan011192/vs-code-effects.git
cd vs-code-effects
./install.sh
```

Then reload the VS Code window. To run from source without install, open this folder in VS Code and push **F5**.

## How it works

1. The timer counts **active time**: the VS Code window has focus, and the time is inside the schedule.
2. When the active time reaches `blackHoleBreak.intervalMinutes`, the break is due. The break starts when you stop typing for `blackHoleBreak.waitForIdleSeconds`.
3. **Animation**:
   - `blackHole` (about 5 s): a black hole opens in the middle of the editor. The text near it goes red first, then each 1-3 character grain spirals in, heats to orange, shrinks and goes through the event horizon. Nearest code falls first. When all code is in, the hole collapses with a warm flash.
   - `dust` (about 3.6 s): a warm flash, the text turns grey, then each grain lifts off, gets smaller, turns and blurs.
4. **Rest** (`blackHoleBreak.restSeconds`): the editor is empty. A short text and a countdown show in the middle.
5. **Restore**: the same animation plays backward. For `blackHole`, the hole opens again and the code spirals back out.

To end a break early, type or click in the editor (`blackHoleBreak.endOnActivity`). The dust flies back from its current position.

If you leave the VS Code window for `blackHoleBreak.resetAfterAwaySeconds` (default 5 min), that counts as a break, and the timer starts again from zero.

## Time filter

| Setting | Example | Effect |
|---|---|---|
| `blackHoleBreak.activeHours` | `09:00-12:30, 13:30-18:00` | Breaks only in these local-time ranges. Empty = all day. Overnight ranges (`22:00-02:00`) are permitted. |
| `blackHoleBreak.activeDays` | `["Mon","Tue","Wed","Thu","Fri"]` | Breaks only on these days. |

Outside the filter, the timer stops. It does not reset.

## Settings

| Setting | Default | Description |
|---|---|---|
| `blackHoleBreak.effect` | `blackHole` | `blackHole` or `dust`. |
| `blackHoleBreak.enabled` | `true` | Timer on or off. |
| `blackHoleBreak.intervalMinutes` | `10` | Active minutes between breaks. |
| `blackHoleBreak.restSeconds` | `20` | Length of the empty-editor rest. |
| `blackHoleBreak.activeHours` | `""` (all day) | Time filter (see above), e.g. `09:00-12:30, 13:30-18:00`. |
| `blackHoleBreak.activeDays` | all days | Day filter. |
| `blackHoleBreak.waitForIdleSeconds` | `3` | Typing pause before a due break starts. |
| `blackHoleBreak.resetAfterAwaySeconds` | `300` | Time away that counts as a break. |
| `blackHoleBreak.endOnActivity` | `true` | Typing or clicking ends the break. |
| `blackHoleBreak.message` | `Rest your eyes. Look at something far away.` | Text during the rest. Empty = no text. |
| `blackHoleBreak.ghostOpacity` | `0` | Opacity of the hidden code during the rest (0 to 0.5). |
| `blackHoleBreak.animationSpeed` | `1` | Animation speed. |
| `blackHoleBreak.fps` | `30` | Frame rate. A lower value uses less CPU. The duration does not change. |
| `blackHoleBreak.flash` | `true` | Warm flash at the start. |

Example `settings.json` for the 20-20-20 rule on work days:

```json
"blackHoleBreak.intervalMinutes": 20,
"blackHoleBreak.restSeconds": 20,
"blackHoleBreak.activeHours": "09:00-18:00",
"blackHoleBreak.activeDays": ["Mon", "Tue", "Wed", "Thu", "Fri"]
```

## Status bar and commands

The status bar item (right side) shows an eye icon and the active time to the next break, for example `14m`. Click it to open a menu.

Command Palette (`Black-Hole Break: ...`):

- **Take a Break Now**: use this to see the animation.
- **End Break**
- **Reset Timer**
- **Pause for 1 Hour** / **Resume**
- **Enable / Disable**

The extension has no keybindings. The context key `blackHoleBreak.active` is true during a break, if you want to add your own keybinding.

## Time model

```
t += realElapsed * speed * direction          // src/timeline.js, each frame
look(chunk, t) = pure function of t           // src/core.js chunkState()
```

Each grain has a fixed `delay` and `life`:

| t | Look |
|---|---|
| `t < delay - 0.35` | normal |
| `delay - 0.35 <= t < delay` | grey (3 levels) |
| `delay <= t < delay + life` | flight stage `floor(12 * (t - delay) / life)`: offset, turn, scale, blur, fade |
| `t >= delay + life` | gone |

`delay` comes from the column (the right side of a line goes first, downwind), 2D value noise (ragged edge) and a small random value.
No state is kept from frame to frame. Thus reverse play is exact, and a low frame rate gives fewer frames but the same duration.

## Black hole geometry

The hole is at the middle visible line, at half the width of the widest visible line.
Each grain gets its vector `v` from the hole as two CSS custom properties.
These come from two decorations on the same text range:

```
--bh-x: <columns>ch      --bh-y: <lines>lh
```

A stage decoration moves the grain on a spiral. With `p` = fall progress (0 to 1):

```
r = (1 - p)^1.5          theta = THETA[variant] * p^1.7
A = r cos(theta) - 1     B = r sin(theta)
translate: (A*vx - B*vy, B*vx + A*vy)
rotate: theta            scale: (1 - p)^0.8        heat: sepia, saturate, hue-rotate, glow
```

`ch` and `lh` make the spiral end at the hole for any font size and line height.
The hole is two empty attachments (`content: ''`) with absolute position:
- a tilted accretion disk (conic gradient, turned 150°/s),
- an event horizon (black circle, photon ring, glow).

Vector decorations change only when the visible window changes. Each frame changes only the stage decorations and the hole.

## Implementation notes

- The look of each grain is a VS Code text decoration. Dust: 52 stage types. Black hole: 68 stage types, plus vector types (one for each column or line offset in use) and hole types (made for each break, then removed). Each frame only gives new ranges to the types that changed.
- VS Code copies the `textDecoration` value into the CSS rule without changes. The extension uses this to add `display: inline-block`, transforms, filters and custom properties. A transform does not change the layout, so the cursor and the line positions stay the same.
- Needs VS Code 1.85 or later (CSS `lh` unit, individual `translate` / `rotate` / `scale` properties).
- Only the visible lines (+6 lines) are split into grains. One range hides the lines off screen.
- Documents are not changed. Only decorations are added. They are all removed at the end of the break.

## Limits

- The minimap is not hidden. Set `"editor.minimap.enabled": false` for a fully empty view.
- Indent guides and line numbers stay visible.
- If you enable the experimental GPU renderer (`editor.experimentalGpuAcceleration`), the animation can look different.

## Files

| File | Purpose |
|---|---|
| `extension.js` | Scheduler, break phases, status bar, commands |
| `src/core.js` | Dust: pure logic (grains, look at time t, styles), schedule parser |
| `src/blackhole.js` | Black hole: pure logic (vectors, spiral stages, hole size, styles) |
| `src/blackhole-renderer.js` | Black hole decorations |
| `src/timeline.js` | Animation clock |
| `src/timer.js` | Active-time counter |
| `src/renderer.js` | Dust decorations |
| `test/` | `npm test` (Node built-in test runner, fake `vscode` module) |
| `media/` | Animation previews, recorded in a Monaco editor with the same decoration CSS (see `../preview`) |
