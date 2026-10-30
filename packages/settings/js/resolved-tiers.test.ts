// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every printer's shipped resolved data covers the quality tiers the app offers: at the default nozzle, each tier the
// maker has a preset for (packages/profiles/process-speeds.json) is in the data and the data is based on Standard, and on
// every nozzle the app offers the Goal tiles go from thicker to thinner layers, Draft over Standard over Fine. A dump
// that left tiers out (the K1C had only its 0.08 mm one) printed every goal at one layer height.
import { describe, expect, it } from 'vitest'
import speedsJson from '@slicerx/profiles/process-speeds.json'
import printersJson from '../profiles/printers.json'
import { hasResolved, resolvedNozzles, resolvedProfile } from './resolved'
import { stockLayer } from './stock-layer'

const PRINTERS = (printersJson as unknown as { printers: { id: string; nozzles: number[]; defaultNozzle: number }[] }).printers.filter((p) => hasResolved(p.id))
const SPEEDS = (speedsJson as unknown as { models: Record<string, Record<string, string>> }).models

/**
 * Nozzles whose maker presets are themselves out of order, so the shipped data is right and the tiles follow it. The
 * MINI+ 0.25 mm Standard is a 0.20 mm preset (Draft is held to 75 percent of the nozzle, 0.19 mm); the Ender-3 V3 KE has
 * no 0.8 mm Standard or Fine, and its 0.20 mm Standard lists the 0.8 mm nozzle (Fine is held to 25 percent, 0.20 mm).
 */
const MAKER_ORDER: Record<string, string> = {
  'prusa-mini-plus 0.25': 'draft 0.19, standard 0.2, fine 0.12',
  'creality-ender-3-v3-ke 0.8': 'draft 0.24, standard 0.2, fine 0.2',
}

describe('resolved quality tiers', () => {
  it('carry every tier the maker has a preset for at the default nozzle, based on Standard', async () => {
    const missing: string[] = []
    expect(PRINTERS.length).toBeGreaterThan(40)
    for (const p of PRINTERS) {
      if (!(await resolvedNozzles(p.id)).length) continue
      for (const tier of Object.keys(SPEEDS[p.id] ?? {})) {
        const r = await resolvedProfile(p.id, tier)
        if (r?.tier !== tier) missing.push(`${p.id} ${tier}: resolves to ${r?.tier ?? 'nothing'}`)
      }
    }
    expect(missing.join('\n')).toBe('')
  })

  it('give Draft thicker layers than Standard and Fine thinner on every nozzle the app offers', async () => {
    const wrong: string[] = []
    for (const p of PRINTERS) {
      if (!(await resolvedNozzles(p.id)).length) continue
      for (const nozzle of p.nozzles) {
        const l = await stockLayer({ printerId: p.id, tier: 'standard', slots: [], nozzle })
        const h = (g: 'draft' | 'standard' | 'fine') => Number(l!.goalValues[g]['layer_height'])
        const got = `draft ${h('draft')}, standard ${h('standard')}, fine ${h('fine')}`
        const known = MAKER_ORDER[`${p.id} ${nozzle}`]
        if (known ? got !== known : !(h('draft') > h('standard') && h('standard') > h('fine'))) wrong.push(`${p.id} ${nozzle} mm: ${got}`)
      }
    }
    expect(wrong.join('\n')).toBe('')
  })
})
