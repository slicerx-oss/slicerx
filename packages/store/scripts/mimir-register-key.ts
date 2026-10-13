// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sets the edition's mimir registration key on the hosted project, a deployment step after
// migration 0020. Only the key's sha256 reaches the database; the key itself goes into the
// edition's desktop build as SX_MIMIR_REGISTER_KEY.
//
//   SLICERX_SUPABASE_URL=... SLICERX_SERVICE_ROLE_KEY=... SX_MIMIR_REGISTER_KEY=... \
//     pnpm --filter @slicerx/store mimir:register-key [--rotate] [--clear-previous]
//
// --rotate keeps the current key working until the builds that carry it are gone; then
// --clear-previous retires it. The edition is SLICERX_CONFIG when set, else
// editions/slicerx/edition.config.ts. Keys and the service role key come from the environment
// and are never printed or written anywhere.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { loadEditionConfig } from '@slicerx/edition-config/node'
import { keyUpdate } from './mimir-key'

const { values } = parseArgs({ options: { rotate: { type: 'boolean', default: false }, 'clear-previous': { type: 'boolean', default: false } } })

let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
  const up = dirname(root)
  if (up === root) throw new Error('repository root not found')
  root = up
}
const own = join(root, 'editions', 'slicerx', 'edition.config.ts')
const named = process.env['SLICERX_CONFIG'] ?? (existsSync(own) ? own : undefined)
const config = await loadEditionConfig({ cwd: root, ...(named ? { file: named } : {}) })

const url = process.env['SLICERX_SUPABASE_URL']
const service = process.env['SLICERX_SERVICE_ROLE_KEY']
const key = process.env['SX_MIMIR_REGISTER_KEY'] ?? ''
if (!url || !service || (!key && !values['clear-previous'])) {
  console.error('set SLICERX_SUPABASE_URL, SLICERX_SERVICE_ROLE_KEY and SX_MIMIR_REGISTER_KEY in the environment')
  process.exit(1)
}
const sb = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
const limits = sb.from('mimir_limits')
const { data: row, error: readError } = await limits.select('register_key_hash').eq('edition', config.id).maybeSingle()
if (readError || !row) {
  console.error(readError?.message ?? `edition "${config.id}" has no mimir_limits row; apply migration 0020 first`)
  process.exit(1)
}
let change: Record<string, string | null>
try {
  change = values['clear-previous'] ? { register_key_prev_hash: null } : keyUpdate(key, row.register_key_hash as string | null, values.rotate)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
const { error } = await limits.update(change).eq('edition', config.id)
if (error) {
  console.error(error.message)
  process.exit(1)
}
console.log(values['clear-previous'] ? `mimir: the previous registration key for "${config.id}" no longer registers` : `mimir: registration key ${values.rotate ? 'rotated' : 'set'} for "${config.id}"`)
