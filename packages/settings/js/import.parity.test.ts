// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile, project and export results both languages must reproduce. Run with UPDATE_GOLDEN=1 to rewrite
// fixtures/import-golden.json from this implementation.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PrintConfig, SettingSection } from '@slicerx/contracts/settings'
import { exportOrcaProfile, importOrcaProfile } from './import'
import { importProject } from './project'

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url))
const read = (p: string): unknown => JSON.parse(readFileSync(dir + p, 'utf8'))
const update = process.env['UPDATE_GOLDEN'] === '1'

interface Case {
  name: string
  kind: 'profile' | 'project' | 'export'
  from?: string
  profile?: unknown
  parentsOverride?: Record<string, unknown>[]
  projectSettings?: unknown
  modelSettings?: string
  layerRanges?: string
  config?: PrintConfig
  meta?: { name: string; section: SettingSection; inherits?: string }
}

function folder(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const sub of ['process', 'filament', 'machine']) for (const f of readdirSync(dir + 'profiles/' + sub).sort()) out.push(read(`profiles/${sub}/${f}`) as Record<string, unknown>)
  return out
}

function run(c: Case): unknown {
  try {
    if (c.kind === 'export') return JSON.parse(JSON.stringify(exportOrcaProfile(c.config as PrintConfig, c.meta as { name: string; section: SettingSection })))
    if (c.kind === 'project') return JSON.parse(JSON.stringify(importProject({ projectSettings: c.projectSettings, ...(c.modelSettings ? { modelSettings: c.modelSettings } : {}), ...(c.layerRanges ? { layerRanges: c.layerRanges } : {}) })))
    const parents = c.parentsOverride ?? folder()
    const byName = new Map(parents.map((p) => [String(p['name']), p]))
    const json = c.from ? byName.get(c.from) : c.profile
    return JSON.parse(JSON.stringify(importOrcaProfile(json, (n) => byName.get(n))))
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const cases = (read('import-cases.json') as { cases: Case[] }).cases

describe('import golden file', () => {
  if (update) {
    it('rewrites the golden file', () => {
      const lines = cases.map((c) => `  ${JSON.stringify(c.name)}: ${JSON.stringify(run(c))}`)
      const head = JSON.stringify('Written by js/import.parity.test.ts (UPDATE_GOLDEN=1). Both implementations must produce these results.')
      writeFileSync(dir + 'import-golden.json', `{\n "comment": ${head},\n "results": {\n${lines.join(',\n')}\n }\n}\n`)
    })
    return
  }
  const golden = (read('import-golden.json') as { results: Record<string, unknown> }).results
  it('has a result for every case', () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort())
  })
  for (const c of cases) {
    it(`${c.kind}: ${c.name}`, () => {
      expect(run(c)).toEqual(golden[c.name])
    })
  }
})
