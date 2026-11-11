// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the app's page (vite build) and puts it in dist/ touching only the files that changed (sync-dir.mjs).
//   node apps/desktop/scripts/build-page.mjs
// The app embeds every file of dist/ when it compiles (tauri::generate_context!, include_bytes!), and cargo rebuilds
// it when one of them has a newer time. vite empties and rewrites dist/ on every build, so a page with the same bytes
// still recompiled the app; built into a staging folder (node_modules/.cache/build-page) and synced, it does not.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { syncDir } from './sync-dir.mjs'

const desktop = resolve(import.meta.dirname, '..')
const stage = join(desktop, 'node_modules', '.cache', 'build-page')
rmSync(stage, { recursive: true, force: true })
const r = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', stage, '--emptyOutDir'], { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status !== 0) {
  console.error(`build-page: vite build failed (${r.error?.message ?? `exit ${r.status}`})`)
  process.exit(r.status || 1)
}
const { written, removed, same } = syncDir(stage, join(desktop, 'dist'))
console.log(`build-page: ${written.length} files written, ${removed.length} removed, ${same} unchanged in dist`)
