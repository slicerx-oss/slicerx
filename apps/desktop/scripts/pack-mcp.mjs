// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the MCP server and the STEP reader beside it into src-tauri/resources/mcp, which the bundle ships as
// Resources/mcp. The window's STEP import loads the reader's wasm from there (src/host/step-wasm.ts), and the page
// carries no copy of its own (step-wasm-plugin.ts), so an app built without it opens no STEP file.
//   node apps/desktop/scripts/pack-mcp.mjs [--out <dir>]
// It is the first half of Tauri's beforeBuildCommand (src-tauri/tauri.conf.json), so every `tauri build` runs it:
// build:app, edition:build, the bridge build, the release scripts and a copy of the release workflow. `tauri dev`
// does not, since the dev server serves the reader's own wasm. build.rs stops a build whose folder is still empty
// (src-tauri/build-checks/step_reader.rs). release/prepare-sidecars.mjs runs it with --out for its resources folder.
//
// It builds into a staging folder of its own (node_modules/.cache/pack-mcp) and then copies into the resources only the
// files whose bytes changed, removing the ones the build no longer makes (sync-dir.mjs). tauri_build watches the
// resources, so a rewrite with the same bytes would still rerun the build script and recompile the app, about 4 minutes
// of a release build; with nothing changed, cargo has nothing to do.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { syncDir } from './sync-dir.mjs'

const desktop = resolve(import.meta.dirname, '..')
const repo = resolve(desktop, '../..')
const at = process.argv.indexOf('--out')
const out = at >= 0 ? resolve(process.argv[at + 1] ?? '') : join(desktop, 'src-tauri', 'resources', 'mcp')
// one staging folder for each output folder, at the same path every run, so the build's bytes do not depend on it
const stage = join(desktop, 'node_modules', '.cache', 'pack-mcp', createHash('sha256').update(out).digest('hex').slice(0, 12))
rmSync(stage, { recursive: true, force: true })

const r = spawnSync(process.execPath, [join(repo, 'packages', 'mcp', 'scripts', 'build.mjs'), '--standalone', stage, '--step-reader'], { cwd: repo, stdio: 'inherit' })
if (r.status !== 0) {
  console.error(`pack-mcp: the MCP server and STEP reader did not build (${r.error?.message ?? `exit ${r.status}`})`)
  process.exit(r.status || 1)
}
const { written, removed, same } = syncDir(stage, out, { keep: ['.gitkeep'] })
console.log(`pack-mcp: ${written.length} files written, ${removed.length} removed, ${same} unchanged in ${out}`)
for (const f of ['slicerx-mcp.mjs', 'step-reader/occt-import-js.wasm', 'step-reader/occt-import-js.mjs']) {
  const file = join(out, f)
  if (!existsSync(file) || statSync(file).size === 0) {
    console.error(`pack-mcp: ${file} is missing after the build`)
    process.exit(1)
  }
}
