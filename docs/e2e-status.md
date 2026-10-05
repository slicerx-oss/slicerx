# End-to-end suite status

Playwright suite in `apps/web/e2e`, run from `apps/web` with `pnpm exec playwright test`. It builds and serves a fresh
bundle, then runs the desktop and phone projects with software WebGL, three workers.

## Runs at 2dc3c2e, 2026-10-04

The same commit on the PC, natively on Windows and in WSL, one after the other with nothing else running. The browser is
Playwright's Chromium in both, drawing with SwiftShader.

| Machine | Passed | Skipped | Failed | Wall time |
| --- | --- | --- | --- | --- |
| Windows PC, Windows 11 native (24 threads) | 118 | 70 | 0 | 4.4 min |
| Windows PC, WSL Ubuntu-24.04 | 118 | 70 | 0 | 4.9 min |

### What was red at 83536478 and why

- `plate.spec.ts`, "instances, fill bed and arrange, each one undo step", failed on both, in both projects. Arrange all
  runs in the background, and the spec pressed Undo before it landed, so the first undo took back the fill. The app now
  shows "Arranging" from the first moment and marks the root element `data-sx-busy="arrange"` while an arrange runs
  (`packages/app/src/lib/ready-signal.ts`); the spec waits for the mark to clear. 10 runs in a row pass on each.
- `preview-scrub.spec.ts`, "dragging the sliders with the mouse scrubs layers and moves", failed in both full Linux runs
  and never alone (5 in a row passed). The layer stayed at the top: the spec measured the slider once, and under the
  load of a full run the dock was still settling, so the press landed beside it. Presses now go through the locator,
  which waits for the slider to be stable and uncovered, and each drag measures it again.
- `resize.spec.ts`, "the edge has a tip, and the size survives a reload", failed once on Windows (10 px off). The rail
  animates its width, and the spec read the width as soon as it passed 540 px, partway through. It now waits until two
  reads 150 ms apart agree. 15 runs in a row pass.

### Flaky

Nothing failed in the last two full runs on either platform. The scrub and resize failures above were timing in the
specs, seen only under the load of a full run; neither has failed since its fix (two full runs each, and the repeats
above). Watch for them in the next runs.

## Earlier runs, 2026-10-04

Both runs are from the same commit, one full run each, nothing else of mine on the machine.

| Machine | Passed | Skipped | Failed | Wall time |
| --- | --- | --- | --- | --- |
| Windows PC, WSL Ubuntu-24.04 (24 threads) | 118 | 70 | 0 | 7.7 min |
| Reference Mac (M3 Pro, shared, load 5 to 7 from other jobs) | 118 | 70 | 0 | 5.8 min |

The 70 skips are by design: a spec written for the desktop layout skips on the phone project, and the touch spec skips
on the desktop one.

## What was red and why

- The demo fleet grew to six printers (Bay 6, H2C). The Printers tab and the first-run scan expected five.
- The Preview toolhead is `toolpaths.head` now; the scrub spec still read `toolpaths.nozzle`.
- The first tool change on the H2C is an extruder change of about 16 s, not a 35 s hotend swap, since the filament map
  puts the two colors on different extruders. The spec asked for more than 30 s.
- The playback frame check counted frames over 100 ms. A tool change frame costs 150 to 400 ms on a software renderer
  (a plain frame costs 17 ms), so the ratio failed on both machines. It now checks for a stall: playback gets through,
  no frame takes 3 s, a change frame takes under 1 s.
- The saved side pane width can differ by a pixel after a reload.
- Touch taps: Playwright's `tap()` lifts in the same millisecond, and Chromium on Linux then sends the click to the
  toolbar and not the button. The spec taps for 60 ms, as a finger does, after one mouse click that wakes the page.

## Cold start

The cause of the "Layered X" timeouts on the PC: the browser starts its graphics process with the first WebGL context and
drops it when the last page using it closes, and on WSL with a software renderer that start took 60 to 100 s, inside the
first test. Two changes:

- The app marks its root element with `data-sx-ready`: `engine` once the slicer is loaded, `plate` once the first plate
  has loaded, `viewport` once the 3D view is up (`packages/app/src/lib/ready-signal.ts`). `page.goto` and `page.reload`
  in the fixtures wait for it, and the specs use `plateReady` and `viewportReady` in place of fixed waits.
- A worker-scoped fixture keeps one WebGL page open, so the graphics process starts once per worker before the first test.

With these a cold start is 3 to 4 s on the PC.

## Rust tests

At 83536478 and after, `cargo test` for `sx-core`, `sx-geom`, `sx-connect` and `sx-link` passes on Windows and Linux.
The Home Assistant failure noted in the earlier runs is gone. The Windows-only failures fixed on the way: the reference
G-code golden (`powi` rounded differently in unoptimized Windows builds; `sx-core` and `sx-geom` use `m_powi` now), the
mock printers' fixture path, and Bambu FTPS uploads that timed out because the data connection closed with unread TLS
session tickets. The Bambu mock's certificate is X.509 v3 now, which LibreSSL on macOS did not make before.
