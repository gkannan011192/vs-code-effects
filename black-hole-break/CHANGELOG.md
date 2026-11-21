# Changelog

## 0.3.2

- Black hole size follows the screen: the radius grows with the number of visible lines (about 11% of the visible height, 1.2 to 6 lines). A taller editor gets a larger hole.
- New setting `blackHoleBreak.holeScale` (0.5 to 3) to make the hole larger or smaller.
- The hole column moves right when necessary, so the whole disk shows.

## 0.3.1

- Default time filter removed: breaks run all day, every day. Set `blackHoleBreak.activeHours` to limit them.

## 0.3.0

- Renamed from Dust Break to Black-Hole Break (`local-dev.black-hole-break`).
- Settings and commands renamed from `dustBreak.*` to `blackHoleBreak.*`.

## 0.2.0

- New default effect `blackHole`: the code spirals into a black hole, the hole collapses with a flash; on restore the code spirals back out.
- New setting `dustBreak.effect` (`blackHole` | `dust`).
- Needs VS Code 1.85 or later.

## 0.1.2

- Default break interval: 10 active minutes.
- Default active days: all days.

## 0.1.1

- Default time filter: 09:00-12:30 and 13:30-18:00, Monday to Friday.

## 0.1.0

- Timed eye breaks: code dissolves into dust, rest, code reassembles.
- Time filter (active hours, active days), idle wait, away reset.
- Status bar countdown and menu.
