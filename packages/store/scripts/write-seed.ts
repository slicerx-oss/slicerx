// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes packages/store/seed/*.json and supabase/seed/*.sql from generateSeed().
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSeed } from '../src/seed/generate'
import { renderSeedJson } from '../src/seed/json'
import { renderSeedSql } from '../src/seed/sql'

const here = dirname(fileURLToPath(import.meta.url))
const seedDir = join(here, '..', 'seed')
const seed = generateSeed()
mkdirSync(seedDir, { recursive: true })
for (const [name, text] of Object.entries(renderSeedJson(seed))) {
  writeFileSync(join(seedDir, name), text)
}
const sqlDir = join(here, '..', '..', '..', 'supabase', 'seed')
mkdirSync(sqlDir, { recursive: true })
for (const [name, text] of Object.entries(renderSeedSql(seed))) {
  writeFileSync(join(sqlDir, name), text)
}
console.log(`seed: ${seed.creators.length} creators, ${seed.listings.length} listings, ${seed.audit_log.length} audit rows`)
