// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The knowledge base's print-in-place clearance table matches the fit rule it is written from: fits.yaml holds what
// scripts/fit-table.ts writes, kb.json was built from it, and each figure is the rule's suggested gap.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import kb from '../src/kb/generated/kb.json'
import { assessFit } from '../skills/fit_check/index'
import { clearanceFacts, printInPlaceClearance, TABLE_MATERIALS, TABLE_NOZZLES } from '../skills/fit_check/clearance'
import { clearanceTableLines, TABLE_END, TABLE_START, withClearanceTable } from '../skills/fit_check/table'

const fitsYaml = readFileSync(join(__dirname, '..', '..', '..', 'knowledge', 'workflows', 'techniques', 'fits.yaml'), 'utf8')

describe('the clearance table', () => {
  it('in fits.yaml is what the fit rule writes (run pnpm --filter @slicerx/pilot fit:table, then kb:build)', () => {
    expect(fitsYaml).toContain(TABLE_START)
    expect(fitsYaml).toContain(TABLE_END)
    expect(withClearanceTable(fitsYaml)).toBe(fitsYaml)
    const lines = fitsYaml.split('\n')
    expect(lines.slice(lines.indexOf(TABLE_START), lines.indexOf(TABLE_END) + 1)).toEqual(clearanceTableLines())
  })

  it('is in the built knowledge base with its source', () => {
    const doc = (kb as { docs: { id: string; data: { facts?: { text: string; src: string[] }[] } }[] }).docs.find((d) => d.id === 'fits')!
    const facts = doc.data.facts!.filter((f) => f.src.includes('slicerx_fit_rule')).map((f) => f.text)
    expect(facts).toEqual(clearanceFacts())
    expect((kb as { sources: { id: string }[] }).sources.some((s) => s.id === 'slicerx_fit_rule')).toBe(true)
  })

  it('gives the fit rule suggested gap for each nozzle and material', () => {
    const facts = clearanceFacts()
    expect(facts).toHaveLength(TABLE_NOZZLES.length)
    TABLE_NOZZLES.forEach((nozzle, i) => {
      for (const material of TABLE_MATERIALS) {
        const at = { gapMm: 0, feature: 'print_in_place' as const, layerHeight: nozzle / 2, lineWidth: Math.round(nozzle * 105) / 100, nozzle, material }
        const side = assessFit({ ...at, direction: 'xy' }).suggestedGapMm
        const vertical = assessFit({ ...at, direction: 'z' }).suggestedGapMm
        expect(printInPlaceClearance({ nozzleMm: nozzle, material })).toMatchObject({ sideMm: side, verticalMm: vertical })
        // the material's entry names its two figures
        expect(facts[i]).toMatch(new RegExp(`${material}( and [A-Z]+)? ${side}( mm side by side)? and ${vertical} mm|[A-Z]+ and ${material} ${side}( mm side by side)? and ${vertical} mm`))
      }
    })
    expect(facts[1]).toBe('Print in place gaps per side, 0.4 mm nozzle at 0.2 mm layers: PLA and ABS 0.3 mm side by side and 0.4 mm above or below; PETG 0.4 and 0.6 mm; TPU 0.4 and 0.4 mm.')
  })
})
