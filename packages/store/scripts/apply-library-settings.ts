// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copies the edition's library settings (moderation mode, file size limit and allowed
// formats) into the database and onto the storage buckets:
//
//   SLICERX_SUPABASE_URL=... SLICERX_SERVICE_ROLE_KEY=... pnpm --filter @slicerx/store library:settings
//
// The edition is SLICERX_CONFIG when set, else editions/slicerx/edition.config.ts. Run it
// once after the migrations and again whenever the edition's library.moderation changes.
// The service role key comes from the environment and is never written anywhere.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { loadEditionConfig } from '@slicerx/edition-config/node'

let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
  const up = dirname(root)
  if (up === root) throw new Error('repository root not found')
  root = up
}
const own = join(root, 'editions', 'slicerx', 'edition.config.ts')
const named = process.env['SLICERX_CONFIG'] ?? (existsSync(own) ? own : undefined)
const config = await loadEditionConfig({ cwd: root, ...(named ? { file: named } : {}) })
const { mode, maxFileMb, allowedFormats } = config.library.moderation

const url = process.env['SLICERX_SUPABASE_URL']
const key = process.env['SLICERX_SERVICE_ROLE_KEY']
if (!url || !key) {
  console.error('set SLICERX_SUPABASE_URL and SLICERX_SERVICE_ROLE_KEY in the environment')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const { error } = await sb.rpc('apply_library_settings', { p_mode: mode, p_max_file_mb: maxFileMb, p_formats: allowedFormats })
if (error) {
  console.error(error.message)
  process.exit(1)
}
console.log(`library settings applied for edition "${config.id}": mode ${mode}, up to ${maxFileMb} MB, formats ${allowedFormats.join(', ')}`)
