// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the MCP server and the STEP reader beside it into src-tauri/resources/mcp, which the bundle ships as
// Resources/mcp. The window's STEP import loads the reader's wasm from there (src/host/step-wasm.ts), and the page
// carries no copy of its own (step-wasm-plugin.ts), so an app built without it opens no STEP file.
//   node apps/desktop/scripts/pack-mcp.mjs
// It is the first half of Tauri's beforeBuildCommand (src-tauri/tauri.conf.json), so every `tauri build` runs it:
// build:app, edition:build, the bridge build, the release scripts and a copy of the release workflow. `tauri dev`
// does not, since the dev server serves the reader's own wasm. build.rs stops a build whose folder is still empty
// (src-tauri/build-checks/step_reader.rs).
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '..')
const repo = resolve(desktop, '../..')
const out = join(desktop, 'src-tauri', 'resources', 'mcp')

const r = spawnSync(process.execPath, [join(repo, 'packages', 'mcp', 'scripts', 'build.mjs'), '--standalone', out, '--step-reader'], { cwd: repo, stdio: 'inherit' })
if (r.status !== 0) {
  console.error(`pack-mcp: the MCP server and STEP reader did not build (${r.error?.message ?? `exit ${r.status}`})`)
  process.exit(r.status || 1)
}
for (const f of ['slicerx-mcp.mjs', 'step-reader/occt-import-js.wasm', 'step-reader/occt-import-js.mjs']) {
  const file = join(out, f)
  if (!existsSync(file) || statSync(file).size === 0) {
    console.error(`pack-mcp: ${file} is missing after the build`)
    process.exit(1)
  }
}
