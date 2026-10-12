# Spoolhouse: a sample app that builds SlicerX in

Spoolhouse is a made-up filament tracker that uses SlicerX the way an outside app does, following [docs/integrators/quickstart.md](../../docs/integrators/quickstart.md) step for step. It installs `@slicerx/viewport`, `@slicerx/embed` and `@slicerx/mcp` from tarballs packed like the npm packages, not from the workspace.

- `src/main/slicerx.ts`: the main process side. Starts the SlicerX MCP server and slices through it.
- `src/main/cli.ts`: reads the plate of a two-color 3MF, slices it for a Bambu Lab A1 with a stock PLA preset in slot 1 and the user's own PETG preset (`fixtures/My PETG.json`) in slot 2, writes a `.gcode.3mf` with the plate picture, reports progress, and shows four error codes. With an account token it locks the project as `.sxlock` and opens it again.
- `src/main/locked.ts`: locked projects with `@slicerx/embed/sxlock`.
- `src/renderer/`: the window. The pre-alpha agreement first, then the sliced plate in the SlicerX viewport, grams per slot and the settings panel, in Spoolhouse's amber theme (`brand.ts`), dark and light.

`fixtures/x-mark-2color.3mf` is the SlicerX reference X (Apache-2.0, `packages/core/bench/models`).

## Run it

```sh
node ../../scripts/pack-integrator-kit.mjs .kit --engine engine-v0.1.4   # packs the three packages and the engine
npm install .kit/*.tgz                                  # the line the pack script prints
npm run slice                                           # slices, writes out/report.json and public/
npm run build && npm run preview                        # the window on http://127.0.0.1:4388
```

`--engine` downloads the engine release's archives, checks them against its `SHA256SUMS.txt` and unpacks one folder per platform: `.kit/engine/macos-universal`, `windows-x64` and `linux-x64`, each with `sx`, `sx-geom` and `sx-link` in `bin/`. `npm run slice` picks the one for this machine (`kitSx` in `src/main/slicerx.ts`); a real app ships only that one. To slice with an `sx` you built (`cargo build -p sx-cli --release` at the repository root), set `SLICERX_SX_BIN=../../target/release/sx`; it wins over the kit.

The locked project step needs `SLICERX_MCP_SXLOCK_TOKEN` (an `sxk_` token with `sxlock_open` and `sxlock_seal`), `SLICERX_MCP_SUPABASE_URL` and `SLICERX_MCP_SUPABASE_ANON_KEY` in the environment, and is skipped without them.

## The integration test

```sh
node scripts/integration.mjs
```

copies the sample to a temporary folder, packs and installs the packages there, runs the slice, checks the `.gcode.3mf`, the error codes and the published types, builds the window, and drives it in headless Chromium: the agreement takes the brand, accepting it records the version, and the viewport and settings panel show Spoolhouse's colors in dark and light. CI runs it on Linux; it needs Node 24, npm, pnpm and a built `sx`.
