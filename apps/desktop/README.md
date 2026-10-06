# @slicerx/desktop

The desktop build of SlicerX on Tauri 2. The frontend mounts `@slicerx/app` with the desktop `Host` (`src/host/`): the browser host with native slicing and native file dialogs in place of the browser versions. `src-tauri/` is the Rust crate `slicerx-desktop`.

## Commands

The Rust side exposes:

- `load_mesh` (raw bytes, file name in the `x-sx-name` header), `slice` (the same request JSON the WASM worker takes; runs sx-core on every core off the main thread), `get_preview` and `get_gcode` (raw bytes, not JSON), `release`
- `open_files`, `read_file`, `save_file`: Rust shows the native dialog and keeps the paths, so the web view never names a file path
- `update_mode`, `update_check`, `update_download`, `update_restart`: in-app updates; the page asks before the restart (`release/updates.md`)
- `probe_enabled` and `probe_report`: with `SX_PROBE=1` the app slices the example plate through `slice`, prints one `sx-probe {json}` line with launch and slice times, and exits

Planned: `slice_cancel`, printers through sx-connect, the LLM transport through sx-llm, approvals through sx-permit, and secrets in the OS keychain. Until then the desktop app uses the same TypeScript printer, approval and store code as the browser build.

Cargo features `store`, `pilot`, `connect` and `cloud` (all on by default) gate the optional crates; `cargo build -p slicerx-desktop --no-default-features` builds the base app.

```
pnpm --filter @slicerx/desktop tauri dev     # cargo must be on PATH
pnpm --filter @slicerx/desktop build:app     # tauri build with the edition's product name, identifier and deep links
```

`build:app` writes the edition's Tauri settings to `src-tauri/gen/edition.conf.json` (from `SLICERX_CONFIG`, default the SlicerX edition) and passes them to `tauri build --config`.

Prerequisites: the pinned Rust toolchain, Node 24 with pnpm 10, and the platform's Tauri dependencies (Xcode command line tools on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux). Icons are generated from `icons-src/icon-1024.png` with `pnpm tauri icon icons-src/icon-1024.png -o src-tauri/icons`.

Dependencies: tauri 2.12.0, tauri-build 2.7.0, tauri-plugin-dialog 2.8.0, tauri-plugin-updater 2.13.1, serde 1.0.229, serde_json 1.0.151, anyhow 1.0.104; @tauri-apps/api and @tauri-apps/cli 2.12.0.

## Releases

`.github/workflows/desktop-release.yml` builds macOS (universal dmg), Windows (x64 NSIS and MSI) and Linux (x64 AppImage and deb) on a `v*` tag or by hand, and attaches them to a draft release together with `downloads.json` and `SHA256SUMS.txt`. It never publishes. Signing and notarization use these secrets and are skipped when they are absent: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (macOS) and `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` (Windows). The in-app updater (`src-tauri/src/updates.rs`, `tauri-plugin-updater`) reads the feed and key in the edition config; update bundles are signed on the release Mac, never in CI (`release/updates.md`).

`release/whats-changed.mjs` writes the "What changed" list for a release's notes from `User-note:` commit trailers and merged pull requests with the `user-facing` label (their "For users" line); `Reported-in:` names the bug report a change fixes, and `Urgent:` (or the `urgent` label) marks a hotfix that asks everyone to update; only those releases ping in Discord.

`release/downloads.json` is the manifest the site reads (empty until a release exists); `release/make-manifest.mjs` writes it from a folder of installers. `release/check-windows.sh` type-checks the Windows target from macOS or Linux.

## Status

Builds and runs on macOS with native slicing and native file dialogs; `cargo clippy` passes with and without the default features. The universal macOS dmg builds unsigned, the Windows target passes `cargo check`, and Windows and Linux installers are produced by CI only (Linux has not been build-tested yet).

Contributions: see CONTRIBUTING.md at the repository root.
