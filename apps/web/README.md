# @slicerx/web

The browser build of SlicerX (Vite). `src/main.tsx` mounts `@slicerx/app` with the web `Host` from `src/host/`:

- slicing: the WASM worker pool from `@slicerx/slicer`, or its synthetic slicer when the WASM file has not been built
- files: a file picker or the File System Access API, downloads, and drag and drop onto the window
- printers (`connect`): the demo fleet from `@slicerx/fleet-sim`; every side effect is checked against the approval broker with a hash of the exact call before the simulator runs it
- approvals: the TypeScript approval broker, loaded on first use
- store (`store`): the edition's Supabase backend or the bundled demo catalog, loaded on first use
- mimir (`pilot`): the built-in demo model; a real model provider needs `sx-link` running on the same computer

The build reads an edition config (`@slicerx/edition-config`): the product name, theme, printer families, mimir's provider and model, the backend and the source link. `SLICERX_CONFIG` names the file; the default is the SlicerX edition's. `SLICERX_*` values, such as `SLICERX_SUPABASE_URL` and `SLICERX_SUPABASE_ANON_KEY`, can go in a git-ignored `.env.local`; without a backend the store serves its bundled demo catalog.

`SX_FEATURES` overrides the config's feature switches at build time, as a comma list (`store`, `pilot`, `connect`, `cloud`). Unset means all of them; empty means the base app only. Each becomes a compile-time constant, so a disabled feature leaves no code in the bundle.

## Commands

```
pnpm --filter @slicerx/web dev                      # http://localhost:5173
pnpm --filter @slicerx/web build                    # build, then the size budget check
SX_FEATURES= pnpm --filter @slicerx/web build       # base app only
cargo build --release -p sx-cli                     # the native slicer the e2e suite slices with
pnpm --filter @slicerx/web e2e                      # Playwright, headless, 1440 and 390 px
```

The e2e build leaves the WebAssembly slicer out and slices in the native engine, the one the desktop app links. `playwright.config.ts` starts `e2e/native-host/server.mjs` on a free loopback port, runs `sx` from `SX_CLI_BIN` (or this checkout's `target/release/sx`), and builds the app against it (`src/host/native-test.ts`). No other build includes that host: `scripts/check-test-host.mjs` checks the default and CAD-only bundles in CI.

The e2e build has no backend, so the store and feed run on the bundled demo catalog. `SX_E2E_PORT` serves it on another port than 4317, and `SX_TEST_HUB_PORT` moves the bridge specs' sx-link (and the hub the test build pairs with) off 47615, so a second run, the release gate or a running sx-link can share the machine. CI runs the suite in shards, five for the desktop project and one for the phone (job `e2e` in `.github/workflows/ci.yml`), on every change to the web app, the app, the UI or the engine; `vault-flow.spec.ts` and `bridge.spec.ts` skip there, since they need the stack from `e2e/stack/vault-stack.sh` or a built sx-link.

`scripts/bundle-size.mjs` fails the build when the JS loaded before the viewport passes 250 KB gzip or a WASM module passes 1.0 MB gzip.

Dependencies: vite 8.3.1 and @vitejs/plugin-react 6.1.1 for the build, @playwright/test 1.63.0 for end-to-end tests.

## Status

Builds within budget with all features and with none. The end-to-end suite covers the example plate, the command bar from every workspace, free text to mimir, slicing into Preview, the demo printers, the store seed, sidebars that collapse and remember it, and no horizontal scroll at 390 px.

The About link points at `https://github.com/slicerx-oss/slicerx`; change `SOURCE` in `src/host/index.ts` if the source lives elsewhere.

Contributions: see CONTRIBUTING.md at the repository root.
