# The agent bridge

The agent bridge lets an agent read and drive the running desktop app the way a person does: see the tab, the plate,
toasts and dialogs, click and type by test id, open a file or a Vault design, slice, export and take screenshots. It
is the harness the release gate and other real-app runs use, the same on macOS, Windows and Linux. It uses no
debugging port, WebDriver or CDP, so it works on macOS, where the system web view has none.

It exists in dev and test builds only. Release builds never have it, and a check on every release binary proves it.

## Pieces

```
MCP client  --stdio-->  packages/app-bridge   --HTTP, 127.0.0.1, bearer token-->  the app's shell
(Claude Code, ...)      (running-app MCP server)                                  apps/desktop/src-tauri/src/agent_bridge
                                                                                          |  event / command
                                                                                          v
                                                                                  the page: packages/app/src/agent-bridge
```

- **The shell endpoint** (`apps/desktop/src-tauri/src/agent_bridge`, Cargo feature `agent-bridge`). A small HTTP/1.1
  server on 127.0.0.1. It answers what only the shell can do itself: screenshots, opening a file by path and handing
  over a sign-in link (the same code paths a double-clicked file and the deep link take), and writing G-code to a
  folder only the user can open. Every other tool goes to the page as an event and comes back through a command.
- **The page side** (`packages/app/src/agent-bridge`, wired in by `apps/desktop/src/agent-bridge.ts` when the frontend
  is built with `SLICERX_AGENT_BRIDGE=1`). It records console lines, page errors, backend calls, toasts and dialogs,
  reads the app's state, and acts through the controls and commands a person uses.
- **The running-app MCP server** (`packages/app-bridge`). A thin MCP server over stdio, built on the same MCP SDK,
  tool annotations and error shape as `@slicerx/mcp`. Each tool forwards to the shell endpoint.

Why a separate Node server and not MCP served by the shell: the MCP SDK already handles the protocol, its versions and
input validation, and agents start stdio servers on every platform the same way; the shell stays a small JSON endpoint
whose rules are unit tested in Rust and adds no MCP or HTTP dependencies to the app. The server reads the connection
file on every call, so it can start before the app and keeps working across app restarts.

## Build a bridge build

```sh
pnpm install
pnpm --filter @slicerx/desktop build:bridge            # release profile, no installers
pnpm --filter @slicerx/desktop build:bridge -- --debug # faster to build, slower to run
```

`apps/desktop/scripts/bridge-build.mjs` sets `SLICERX_AGENT_BRIDGE=1` for the frontend, builds the shell with
`--features agent-bridge --no-bundle`, and puts it in its own Cargo target folder, `target/agent-bridge`, so a bridge
binary never sits where a release build is picked up. It prints the app's path:
`target/agent-bridge/release/slicerx(.exe)`. On macOS add `-- --target universal-apple-darwin` (or run the binary of
your Mac's own architecture).

A bridge build gets its own identifier, the edition's plus `.agent-bridge` (`app.slicerx.desktop.agent-bridge`). It
keeps its own data folder, web profile, printer hub state and single-instance lock, so it runs next to an installed
SlicerX without reading or changing that copy's state, and never sees the printers paired there. That default is the
safe choice: keep it unless a run truly needs the installed app's state.

`--same-identifier` builds with the edition's own identifier instead. The test build then is the installed SlicerX as
far as the system can tell: it reads and changes the same data folder and web profile (settings, recent and unsaved
projects, the Vault sign-in), sees and can use the printers paired there, and shares the single-instance lock, so
with the installed app running a launch of the test build hands its arguments to that copy and exits (and the other
way round). Quit the installed app first, and expect whatever the run changes to be there the next time the installed
app starts.

The edition config comes from `SLICERX_CONFIG` and the `SLICERX_*` variables as for any build. Without
`SLICERX_SUPABASE_URL` the Vault runs on demo data and nothing reaches a backend. The engine's WASM module and the CAD
module are not built by this script; build them first (`pnpm --filter @slicerx/slicer build:wasm` and
`sh packages/geom/wasm/scripts/build.sh`) when a run needs the browser engine fallback or the CAD tools.

For development, `SLICERX_AGENT_BRIDGE=1 pnpm dev:desktop -- --features agent-bridge` runs the dev server and a debug
shell with the bridge.

## Start it

The bridge starts only when `SX_AGENT_BRIDGE_PORT` is set:

| Variable | Meaning |
| --- | --- |
| `SX_AGENT_BRIDGE_PORT` | The port on 127.0.0.1. `0` picks a free one. Unset: no bridge. |
| `SX_AGENT_BRIDGE_TOKEN_FILE` | Where the connection file goes. Default: `agent-bridge.json` in the app's data folder (`%APPDATA%\app.slicerx.desktop.agent-bridge` on Windows, `~/Library/Application Support/app.slicerx.desktop.agent-bridge` on macOS, `~/.local/share/app.slicerx.desktop.agent-bridge` on Linux; without `.agent-bridge` for a dev run). |

```sh
# macOS and Linux
SX_AGENT_BRIDGE_PORT=0 SX_AGENT_BRIDGE_TOKEN_FILE=/tmp/sx-bridge.json target/agent-bridge/release/slicerx
```

```powershell
# Windows
$env:SX_AGENT_BRIDGE_PORT = '0'; $env:SX_AGENT_BRIDGE_TOKEN_FILE = "$env:TEMP\sx-bridge.json"
$p = Start-Process target\agent-bridge\release\slicerx.exe -PassThru   # stop it later by $p.Id
```

The app writes `{"port", "token", "pid", "app", "version"}` to the connection file, made fresh at every start and readable
only by the user (mode 0600 on macOS and Linux; on Windows an access list of the user and SYSTEM only, not inherited
from the folder), and removes it when it quits. stderr says where it listens. The app is
single-instance per identifier: quit a running copy of the same build first, or the new one hands its arguments to it
and exits. On Windows, `WEBVIEW2_USER_DATA_FOLDER=<empty folder>` gives a run a fresh web profile (first run again).

## Connect an MCP client

```sh
claude mcp add slicerx-app -e SX_AGENT_BRIDGE_TOKEN_FILE=/tmp/sx-bridge.json -- node /path/to/slicerx/packages/app-bridge/src/cli.ts
```

Any MCP client works the same way: the command is `node packages/app-bridge/src/cli.ts` (Node 24 or later), with
`--token-file <path>` or `SX_AGENT_BRIDGE_TOKEN_FILE` naming the connection file, or `--identifier <app id>` for another
edition's data folder. With neither, it looks in the data folders of `app.slicerx.desktop.agent-bridge` and
`app.slicerx.desktop` and reads the file written last.

The release gate ([release-gate.md](release-gate.md)) runs its scenarios through this server with one command.

An end to end run of the whole chain (start the app with a fresh profile, every read, the safe acts, the refusals,
stop by pid) is `node packages/app-bridge/scripts/e2e.mjs [--app <binary>] [--file <model>] [--out <dir>]`.

## Tools

Reads:

| Tool | What it returns |
| --- | --- |
| `app_health` | Whether a bridge build is running: name, version, pid, platform, whether the page side is up (`pageReady`) and the app has started (`appReady`), the tools it serves |
| `app_state` | The tab; the plate with each object's parts, filament slot, size, Vault listing, the object list's warnings and the last slice's warnings; the printer and nozzle; the filament slots; the slicing status with the last slice summary; which export commands are on (`exports`: the mesh exports stay off for a Vault design); whether setup or the save prompt is open; the dialogs and toasts on screen; the log marker |
| `app_toasts` | Toasts with text, tone and time, since a marker |
| `app_dialogs` | Dialogs opening and closing, with titles, test ids and times, since a marker, and the dialogs open now |
| `app_console` | Console lines, page errors, unhandled rejections and content security refusals, since a marker. Tokens are masked |
| `app_network` | Backend calls and failed resource loads: method, address without its query, status, time. Never bodies, headers or tokens |
| `app_user` | Signed in or not, and the user id and email |
| `app_screenshot` | A PNG of the window's content, as an image, and saved to a path when given one |
| `app_element` | Every control with a test id: on screen, enabled, text, value (never a password), checked, pressed, expanded, its other `data-` attributes (the row's `listing` or `object-id`, a `state` or `step`), and the pictures in it (`images`: address without its query, `loaded`, `pending` or `failed`, and whether it is on screen) |
| `app_testids` | The test ids on screen with their counts |

Acts:

| Tool | What it does |
| --- | --- |
| `app_click` | Clicks a control by test id, as a pointer does |
| `app_fill` | Types into an input, text area or select by test id |
| `app_press_key` | Presses a key, with modifiers, on a control or whatever has focus. Escape cancels the open dialog and Enter submits a form field's form, as the browser would |
| `app_wait_for` | Waits until a control is visible, hidden, enabled, present or absent |
| `app_open_file` | Opens a model or project by absolute path the way a double-clicked file arrives, and waits until it is on the plate |
| `app_open_vault_design` | Opens a Vault design by listing id, slug or exact title through its sheet and Open button, with the download a person sees, and waits until it is on the plate |
| `app_clear_plate` | Runs Clear the plate; returns the save question instead of answering it |
| `app_slice` | Runs Slice the plate and waits for the summary: time, grams, layers, tool changes, warnings |
| `app_export_gcode` | Writes the slice's G-code to `slicerx-agent-bridge/<pid>/` in the app's cache folder (`$XDG_RUNTIME_DIR` on Linux when it is set) and returns the path. Refuses a slice that is stale or unsafe to print |
| `app_auth_callback` | Hands a sign-in callback link (`slicerx://auth/callback?...`) to the app through the deep link's path |

Reads that keep a log take `since` (the marker from an earlier answer) and `limit`. Errors come back as
`Error: <code>: <message>`, with `{ error: { code, message } }` as structured content: `not_running`, `unauthorized`,
`invalid_input`, `not_found`, `not_ready` (the app is busy, asking something, or still starting), `refused`,
`timeout`, `page_unavailable` (a frontend built without the bridge).

Controls are found by `data-testid`, which is part of the UI contract: see [test-ids.md](test-ids.md).

## Security model

- **Compiled out of releases.** The shell side exists only with the `agent-bridge` Cargo feature, which no default
  feature turns on. The page side exists only in a frontend built with `SLICERX_AGENT_BRIDGE=1`; any other build drops it
  as dead code. `apps/desktop/release/check-agent-bridge.mjs` fails on the shell's names in an app binary, the page's
  names in a built frontend, a default feature that turns the bridge on, or a release environment with
  `SLICERX_AGENT_BRIDGE=1`. The release workflow, `windows-sign.ps1` and `macos-sign.sh` run it, and CI checks the
  feature set and compiles the bridge on macOS, Windows and Linux.
- **Off unless asked.** Even a bridge build listens only when `SX_AGENT_BRIDGE_PORT` is set.
- **Loopback and a token.** It binds 127.0.0.1 only. Every request needs `Authorization: Bearer <token>`, a fresh
  random 256-bit token per run, compared in constant time. The Host header must name the loopback port and requests
  with an Origin header are refused, so a web page cannot reach it by DNS rebinding. Bodies over 1 MB, chunked bodies
  and anything but the two routes are refused.
- **Nothing destructive.** No tool prints, sends to a printer, deletes an account or anything else. The page refuses
  controls with a `danger-` test id and everything in the approval dialog, the Print sheet or marked
  `data-agent-refuse`; `packages/app/test/test-ids.test.ts` fails when a control that prints, sends, deletes or
  archives has any other test id. Export writes only into the bridge's own folder: a folder of the user's that no
  one else can open (mode 0700, refused when it is a link or another user's), with each file made new (never written
  through a file or link already there) and readable by the user only.
- **No secrets out.** Network logs keep the address without its query string and never a body or header. Console text
  has JWTs, bearer tokens and token-like query values masked. `app_user` gives the user id and email only. A sign-in
  link handed over is never echoed or logged. Password fields never give their value.

## Screenshots on each platform

The web view captures itself, so no screen-recording permission, focus or visible window position is needed:

- **Windows**: WebView2's `ICoreWebView2::CapturePreview` writes a PNG into a COM memory stream.
- **macOS**: `WKWebView takeSnapshotWithConfiguration:completionHandler:` returns an `NSImage`, which
  `NSBitmapImageRep` turns into PNG bytes.
- **Linux**: `webkit_web_view_get_snapshot` (the visible region) returns a cairo surface, written as a PNG by the
  shell (`agent_bridge/png.rs`).

The picture is the window's web content: the native title bar and menu bar are not in it.

## Platform notes

- **macOS**: the same code paths as elsewhere; only the screenshot is platform code. Run the bridge build from a
  Terminal in the desktop session.
- **Windows**: start and stop the app by its process id; never by name.
- **Linux**: WebKitGTK. CI compiles and tests the bridge there.
