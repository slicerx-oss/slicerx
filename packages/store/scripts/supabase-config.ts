// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Rewrites the edition blocks of supabase/config.toml from the edition config:
// SLICERX_CONFIG when set, else the SlicerX edition's own
// editions/slicerx/edition.config.ts. `--check` exits 1 when the file is out of date.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEditionConfig } from '@slicerx/edition-config/node'
import { renderSupabaseConfig } from '../src/supabase-config'

// The repository root is the nearest directory with pnpm-workspace.yaml, so the
// script keeps working if the package moves.
let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
  const up = dirname(root)
  if (up === root) throw new Error('repository root not found')
  root = up
}
const file = join(root, 'supabase', 'config.toml')
const own = join(root, 'editions', 'slicerx', 'edition.config.ts')
const named = process.env['SLICERX_CONFIG'] ?? (existsSync(own) ? own : undefined)
const config = await loadEditionConfig({ cwd: root, ...(named ? { file: named } : {}) })
const current = readFileSync(file, 'utf8')
const next = renderSupabaseConfig(current, config)
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('supabase/config.toml is out of date; run pnpm --filter @slicerx/store supabase:config')
    process.exit(1)
  }
} else if (next !== current) {
  writeFileSync(file, next)
  console.log(`supabase/config.toml: auth blocks updated for edition "${config.id}"`)
}
