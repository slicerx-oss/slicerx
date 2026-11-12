# @slicerx/desktop

The desktop build of SlicerX on Tauri 2. The frontend mounts `@slicerx/app` with the desktop `Host` (`src/host/`): the browser host with native slicing and native file dialogs in place of the browser versions. `src-tauri/` is the Rust crate `slicerx-desktop`.

## Commands

The Rust side exposes:

- `load_mesh` (raw bytes, file name in the `x-sx-name` header), `slice` (the same request JSON the WASM worker takes; runs sx-core on every core off the main thread), `get_preview` and `get_gcode` (raw bytes, not JSON), `release`
- `open_files`, `read_file`, `save_file`: Rust shows the native dialog and keeps the paths, so the web view never names a file path
- `update_mode`, `update_check`, `update_download`, `update_restart`: in-app updates; the page asks before the restart (`release/updates.md`)
- `geom_call`, `geom_end` and `geom_engine` (with the `native-geom` feature): the Model engine in a process of its own, for the page's native geometry provider (below)
- `probe_enabled` and `probe_report`: with `SX_PROBE=1` the app slices the example plate through `slice`, prints one `sx-probe {json}` line with launch and slice times, and exits

Planned: `slice_cancel`, printers through sx-connect, the LLM transport through sx-llm, approvals through sx-permit, and secrets in the OS keychain. Until then the desktop app uses the same TypeScript printer, approval and store code as the browser build.

Cargo features `store`, `pilot`, `connect` and `cloud` (all on by default) gate the optional crates; `cargo build -p slicerx-desktop --no-default-features` builds the base app.

The `native-geom` feature (off by default) links sx-geom with the exact kernel. The page can then run the Model engine natively instead of in its geometry worker: the shell starts its own binary again with `--sx-geom-engine` (`src-tauri/src/geom_host.rs`), and that process serves engine calls over its stdin and stdout as frames (`packages/geom/src/serve.rs`). The page keeps its worker unless `SLICERX_NATIVE_GEOM=1` is set in the app's environment or the developer setting `localStorage['sx.nativeGeom'] = '1'` is on (`src/host/geom-native.ts`); `SLICERX_NATIVE_GEOM=0` keeps the worker either way. A build with the feature compiles the kernel from source, so it needs what the kernel build needs: `SX_SMLIB_DIR` from `packages/brep/scripts/fetch-smlib.sh`, and `SX_BREP_REQUIRE=1` so a build without the kernel source fails instead of building the stand-in. The release paths (`.github/workflows/desktop-release.yml`, `release/windows-sign.ps1` and `release/macos-sign.sh`) turn it on per leg: each fetches the kernel, sets both variables and runs `release/kernel-config.mjs`, which adds `native-geom` to the edition config's `build.features` and the kernel's license files to the bundle. A leg drops the kernel with `kernel: false` in the workflow's matrix, or `SX_RELEASE_KERNEL=0` for the two scripts. A check that the built app reports a real kernel is still to come.

Every build carries its license files in `licenses/` beside its other resources: `LICENSE-APACHE.txt`, `NOTICE.txt` and `THIRD-PARTY.md`, and in a build with the kernel `SMLib-LICENSE.txt` (NVIDIA's license as the kernel's source has it) and `SMLib.txt` (`release/licenses/SMLib.txt`: the notice and the changes SlicerX makes to the kernel's files). About opens the folder (`licenses_open_folder`).

```
pnpm --filter @slicerx/desktop tauri dev     # cargo must be on PATH
pnpm --filter @slicerx/desktop build:app     # tauri build with the edition's product name, identifier and deep links
```

A dev run's printer hub takes 47615 like a release, or the port in `SX_TEST_HUB_PORT` (1024 or above), so it can run beside an installed app's hub, an sx-link or an end-to-end run; the MCP server reads the same variable, and so do sx-link and sx-watch when built with their `test-hub` feature. Release builds never read it.

`build:app` writes the edition's Tauri settings to `src-tauri/gen/edition.conf.json` (from `SLICERX_CONFIG`, default the SlicerX edition) and passes them to `tauri build --config`.

Every `tauri build` (build:app, build:bridge, `pnpm edition:build`, the release scripts) runs `scripts/pack-mcp.mjs` first, as its `beforeBuildCommand`: it packs the MCP server and the STEP reader into `src-tauri/resources/mcp`, which ships as the app's `mcp` resource folder. The window loads the reader's wasm from there (`src/host/step-wasm.ts`) and its page has no copy of its own, so `build.rs` stops a build whose `resources/mcp/step-reader` is missing the reader and says to run `node apps/desktop/scripts/pack-mcp.mjs`. `tauri dev` needs neither: the dev server serves the reader's own wasm. The second half of `beforeBuildCommand`, `scripts/build-page.mjs`, builds the page (`vite build`) into a staging folder and copies into `dist` only the files that changed. Both write only what changed, because cargo rebuilds the app when a watched resource or an embedded page file gets a newer time, so a release build with nothing changed has nothing to compile.

Prerequisites: the pinned Rust toolchain, Node 24 with pnpm 10, and the platform's Tauri dependencies (Xcode command line tools on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux). Icons are generated from `icons-src/icon-1024.png` with `pnpm tauri icon icons-src/icon-1024.png -o src-tauri/icons`.

Dependencies: tauri 2.12.0, tauri-build 2.7.0, tauri-plugin-dialog 2.8.0, tauri-plugin-updater 2.13.1, serde 1.0.229, serde_json 1.0.151, anyhow 1.0.104; @tauri-apps/api and @tauri-apps/cli 2.12.0.

## Releases

`.github/workflows/desktop-release.yml` builds macOS (universal dmg), Windows (x64 NSIS and MSI) and Linux (x64 AppImage and deb) on a `v*` tag or by hand, and attaches them to a draft release together with `downloads.json` and `SHA256SUMS.txt`. It never publishes. Signing and notarization use these secrets and are skipped when they are absent: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (macOS) and `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` (Windows). The in-app updater (`src-tauri/src/updates.rs`, `tauri-plugin-updater`) reads the feed and key in the edition config; update bundles are signed on the release Mac, never in CI (`release/updates.md`).

`release/whats-changed.mjs` writes the "What changed" list for a release's notes from `User-note:` commit trailers and merged pull requests with the `user-facing` label (their "For users" line, left out when the pull request's own commits carry a User-note, and skipped when it refers to a table or to main); `Reported-in:` names the bug report a change fixes, and `Urgent:` (or the `urgent` label) marks a hotfix that asks everyone to update; only those releases ping in Discord. `User-note-replaces: <commit>` drops an earlier commit's User-note that said something wrong, and the new commit's own User-note takes its place, so a shared branch corrects a note without a history rewrite.

`release/downloads.json` is the manifest the site reads (empty until a release exists); `release/make-manifest.mjs` writes it from a folder of installers. `release/check-windows.sh` type-checks the Windows target from macOS or Linux.

## Status

Builds and runs on macOS with native slicing and native file dialogs; `cargo clippy` passes with and without the default features. The universal macOS dmg builds unsigned, the Windows target passes `cargo check`, and Windows and Linux installers are produced by CI only (Linux has not been build-tested yet).

Contributions: see CONTRIBUTING.md at the repository root.
