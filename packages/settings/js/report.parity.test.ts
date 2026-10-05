// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Import report results both languages must reproduce. Run with UPDATE_GOLDEN=1 to rewrite fixtures/report-golden.json
// from this implementation; tests/preset_bundles.rs checks the Rust side against it.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SettingSection } from '@slicerx/contracts/settings'
import { buildReport, countDefaulted, importLayers, importValues, type Dropped, type KeyFamily } from './report'

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url))
const update = process.env['UPDATE_GOLDEN'] === '1'

interface Case {
  name: string
  section: SettingSection
  family: KeyFamily
  layers: { name: string; raw: Record<string, unknown> }[]
  printer?: { name: string; raw: Record<string, unknown> }
  parent?: { name: string; found: boolean }
  extraDropped?: Dropped[]
  defaulted: number | 'count'
}

function run(c: Case): unknown {
  const { config, origin, dropped } = importLayers(c.layers)
  const printer = c.printer ? { name: c.printer.name, config: importValues(c.printer.raw).config } : undefined
  const report = buildReport({
    name: c.layers[0]!.name,
    section: c.section,
    family: c.family,
    dropped: [...dropped, ...(c.extraDropped ?? [])],
    config,
    origin,
    ...(printer ? { printer } : {}),
    ...(c.parent ? { parent: c.parent } : {}),
    defaulted: c.defaulted === 'count' ? countDefaulted(c.section, config) : c.defaulted,
  })
  return JSON.parse(JSON.stringify({ config, origin, report }))
}

const cases = (JSON.parse(readFileSync(dir + 'report-cases.json', 'utf8')) as { cases: Case[] }).cases

describe('import report golden file', () => {
  if (update) {
    it('rewrites the golden file', () => {
      const lines = cases.map((c) => `  ${JSON.stringify(c.name)}: ${JSON.stringify(run(c))}`)
      const head = JSON.stringify('Written by js/report.parity.test.ts (UPDATE_GOLDEN=1). Both implementations must produce these results.')
      writeFileSync(dir + 'report-golden.json', `{\n "comment": ${head},\n "results": {\n${lines.join(',\n')}\n }\n}\n`)
    })
    return
  }
  const golden = (JSON.parse(readFileSync(dir + 'report-golden.json', 'utf8')) as { results: Record<string, unknown> }).results
  it('has a result for every case', () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort())
  })
  for (const c of cases) {
    it(c.name, () => {
      expect(run(c)).toEqual(golden[c.name])
    })
  }
})
