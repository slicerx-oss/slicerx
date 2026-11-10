// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Strong on a printer whose maker ships no strong preset: the maker's Standard with SlicerX's Strength rule (5 walls,
// 35% gyroid infill), not Standard under another name. Every other tier on every stock printer stays as it was:
// fixtures/stock-tiers.json holds a hash of each one, written from the code before this change.
// A stock table or resolved profile refresh changes them on purpose: rewrite them with UPDATE_COMMAND (below).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EasyGoal } from '@slicerx/contracts/settings'
import { listPrinterProfiles } from './profiles'
import { resolvedProfile } from './resolved'
import { stockLayer } from './stock-layer'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'stock-tiers.json')
/** Run from the repository root; it writes the fixture from the stock presets as they are now. */
const UPDATE_COMMAND = 'SX_STOCK_TIERS_UPDATE=1 pnpm --filter @slicerx/settings exec vitest run js/stock-layer-strong.test.ts'
/** The Goal tile keys the fixture was written with; a key added to the tiles later is new, not a change. */
const TILE_KEYS = ['layer_height', 'wall_loops']

/** JSON with its object keys sorted, so a hash depends on the values only. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex').slice(0, 16)

const layer = (printerId: string, tier: EasyGoal) => stockLayer({ printerId, tier, slots: [] })
/** What a Strong slice gets on the printer: the layer's values with the Strong goal in use. */
const strong = async (printerId: string) => (await layer(printerId, 'strong'))!.values
/** Whether the maker ships a strong preset for this printer at its default nozzle (false also for a printer with no maker data). */
const makerStrong = async (printerId: string, nozzle: number) => (await resolvedProfile(printerId, 'strong', nozzle))?.tier === 'strong'
const fallsBack = async (printerId: string, nozzle: number) => {
  const r = await resolvedProfile(printerId, 'strong', nozzle)
  return r !== undefined && r.tier !== 'strong'
}

describe('Strong on a stock printer', () => {
  it('adds walls and infill to the maker\'s Standard where the maker has no strong preset (Standard had 2 walls)', async () => {
    const l = (await layer('prusa-mk4s', 'standard'))!
    expect(await fallsBack('prusa-mk4s', l.nozzle)).toBe(true)
    const std = l.goalValues.standard
    expect(std['wall_loops']).toBe(2)
    const values = await strong('prusa-mk4s')
    expect([values['wall_loops'], values['sparse_infill_density'], values['sparse_infill_pattern']]).toEqual([5, 35, 'gyroid'])
    // the Goal tile reads the same walls
    expect(l.goalValues.strong['wall_loops']).toBe(5)
    // the rest of the slice is the maker's Standard: the same layer height, speeds, shells and line widths
    for (const k of ['outer_wall_speed', 'inner_wall_speed', 'layer_height', 'top_shell_layers', 'line_width']) expect(values[k], k).toEqual(l.values[k])
  })

  it('does the same where Standard had 3 walls', async () => {
    const l = (await layer('voron-2.4-300', 'standard'))!
    expect(await fallsBack('voron-2.4-300', l.nozzle)).toBe(true)
    expect(l.goalValues.standard['wall_loops']).toBe(3)
    const s = await strong('voron-2.4-300')
    expect([s['wall_loops'], s['sparse_infill_density']]).toEqual([5, 35])
    expect(l.goalValues.strong['wall_loops']).toBe(5)
  })

  it('gives every printer that falls back 5 walls and 35% infill', async () => {
    let n = 0
    for (const p of listPrinterProfiles()) {
      const l = await layer(p.id, 'standard')
      if (!l || !(await fallsBack(p.id, l.nozzle))) continue
      n++
      const s = await strong(p.id)
      expect([s['wall_loops'], s['sparse_infill_density']], p.id).toEqual([5, 35])
      expect(l.goalValues.strong['wall_loops'], p.id).toBe(5)
    }
    // 18 printers at 2 walls and 11 at 3 before this change
    expect(n).toBe(29)
  })

  it('keeps the maker\'s own strong preset, including the H2D\'s Balanced Strength', async () => {
    const a1 = (await layer('bambu-a1', 'standard'))!
    expect(await makerStrong('bambu-a1', a1.nozzle)).toBe(true)
    expect((await strong('bambu-a1'))['wall_loops']).toBe(6)
    for (const id of ['bambu-h2d', 'bambu-h2d-pro']) {
      const l = (await layer(id, 'standard'))!
      expect(await makerStrong(id, l.nozzle), id).toBe(true)
      // the maker's Balanced Strength changes shells and speeds, not walls
      const s = await strong(id)
      expect(s['wall_loops'] ?? 2, id).toBe(2)
      expect(s['top_shell_layers'], id).toBe(6)
    }
  })

  it('leaves every other tier on every stock printer as it was', { timeout: 120_000 }, async () => {
    const now: Record<string, string> = {}
    for (const p of listPrinterProfiles()) {
      const std = await layer(p.id, 'standard')
      if (!std) continue
      const tiers: EasyGoal[] = ['draft', 'standard', 'fine']
      // Strong is unchanged wherever it does not fall back: the maker's own preset, or SlicerX's on a printer without maker data
      if (!(await fallsBack(p.id, std.nozzle))) tiers.push('strong')
      for (const t of tiers) {
        const l = t === 'standard' ? std : (await layer(p.id, t))!
        now[`${p.id} ${t}`] = hash(l.values)
        now[`${p.id} ${t} tile`] = hash(Object.fromEntries(TILE_KEYS.map((k) => [k, std.goalValues[t][k]])))
      }
    }
    if (process.env['SX_STOCK_TIERS_UPDATE'] === '1') writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`)
    const before = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>
    const changed = Object.keys({ ...before, ...now }).filter((k) => before[k] !== now[k])
    expect(changed, `Stock presets changed for ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` and ${changed.length - 6} more` : ''}. If this is a stock table or resolved profile refresh, rewrite the fixture from the repository root with: ${UPDATE_COMMAND}`).toEqual([])
  })
})
