// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { runScenario } from '../evals/runner'
import { evalKb } from '../evals/harness'
import { FUNCTION_SCENARIOS, SCENARIOS } from '../evals/skills/a'
import { EXPECTED_REFUSALS, runFunctionScenario } from '../evals/functions'
import { checkDemand, stockRows } from '../skills/spool_inventory/index'
import { energyOf, wattsFor } from '../skills/energy_estimate/index'
import { colorMatches, type SpoolRec } from '../skills/fleet_common/index'
import { rankMaterials } from '../skills/material_recommend/index'
import { overall } from '../skills/overnight_readiness/index'
import { needsPerson } from '../skills/fleet_overview/index'
import { fitsVolume } from '../skills/printer_match/index'
import { planSchedule, type PlanPlate, type PlanPrinter } from '../skills/schedule/index'
import { checkSpoolFit, fitVerdict, swapLayer, type FitResult } from '../skills/spool_fit/index'
import type { ToolContext } from '../src/tool'

const kb = evalKb()
const intent = (id: string) => kb.get('intent', id)
const allIntents = { heat: intent('heat_resistance'), uv: intent('uv_resistance'), flexible: intent('flexibility'), food_contact: intent('food_contact'), strength: intent('strength'), cheap: intent('economy') }

describe('printer_match', () => {
  it('fits boxes in any axis-aligned orientation', () => {
    expect(fitsVolume([200, 20, 150], { x: 180, y: 180, z: 250 })).toBe(true)
    expect(fitsVolume([260, 20, 20], { x: 256, y: 256, z: 256 })).toBe(false)
  })
})

describe('fleet_overview', () => {
  const status = (over: Record<string, unknown>) => ({ printerId: 'p', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '', ...over }) as never
  it('lists paused, finished, offline and low filament', () => {
    expect(needsPerson('p', 'P', status({ state: 'paused', jobName: 'x' })).map((a) => a.kind)).toEqual(['paused'])
    expect(needsPerson('p', 'P', status({ state: 'finished' })).map((a) => a.kind)).toEqual(['finished'])
    expect(needsPerson('p', 'P', null).map((a) => a.kind)).toEqual(['offline'])
    const low = needsPerson('p', 'P', status({ slots: [{ id: 'A1', material: 'PLA', remainingPct: 14 }, { id: 'A2', material: 'PLA', remainingPct: 15 }, { id: 'A3' }] }))
    expect(low.map((a) => a.text)).toEqual(['slot A1 PLA at 14%'])
  })
  it('raises nothing for an idle printer with full spools', () => {
    expect(needsPerson('p', 'P', status({ slots: [{ id: 'A1', material: 'PLA', remainingPct: 80 }] }))).toEqual([])
  })
})

describe('material_recommend ranking', () => {
  const rank = (req: Parameters<typeof rankMaterials>[2], owned = new Map<string, number>()) => rankMaterials(kb.all('filament'), allIntents, req, owned)
  it('rejects PLA for a hot car and puts ASA or better first', () => {
    const r = rank({ needs: ['heat', 'uv'], useTempC: 80 })
    expect(r.find((x) => x.id === 'pla')?.ok).toBe(false)
    expect(r.find((x) => x.id === 'petg')?.ok).toBe(false)
    expect(r[0]?.id).toBe('asa')
    expect(r.some((x) => ['pva', 'bvoh', 'hips'].includes(x.id))).toBe(false)
  })
  it('ranks TPU first for flexible parts', () => {
    expect(rank({ needs: ['flexible'] })[0]?.id).toMatch(/^tpu/)
  })
  it('ranks polypropylene first for chemicals', () => {
    expect(rank({ needs: ['chemical'] })[0]?.id).toBe('pp')
  })
  it('keeps styrenics out of the top for food contact', () => {
    const ids = rank({ needs: ['food_contact'] }).slice(0, 4).map((x) => x.id)
    expect(ids).not.toContain('abs')
    expect(ids).not.toContain('asa')
  })
  it('prefers a spool the user owns', () => {
    const without = rank({ needs: ['strength'] }).findIndex((x) => x.id === 'pla_plus')
    const owned = rank({ needs: ['strength'] }, new Map([['pla_plus', 500]])).findIndex((x) => x.id === 'pla_plus')
    expect(owned).toBeLessThan(without)
  })
})

describe('schedule assignment', () => {
  const printer = (id: string, rate: number, loaded: string[], readyS = 0): PlanPrinter => ({ id, name: id, rate, readyS, loaded: (k) => loaded.includes(k) })
  const plate = (id: string, over: Partial<PlanPlate> = {}): PlanPlate => ({ id, job: id, jobIndex: 0, materialKey: 'pla', copies: 1, durationS: 3600, eligible: () => ({ ok: true, needs: [] }), ...over })
  it('picks the printer with the material loaded over a cheaper one that needs a swap', () => {
    const r = planSchedule([printer('cheap', 0.1, []), printer('loaded', 0.4, ['pla'])], [plate('a', { dueS: 86400 })], 600)
    expect(r.assignments[0]?.printerId).toBe('loaded')
    expect(r.assignments[0]?.swap).toBe(false)
  })
  it('takes the cheapest of the printers that are loaded and idle', () => {
    const r = planSchedule([printer('a', 0.4, ['pla']), printer('b', 0.2, ['pla'])], [plate('x', { dueS: 86400 })], 600)
    expect(r.assignments[0]?.printerId).toBe('b')
  })
  it('notes a spool swap and adds its time when nothing has the material', () => {
    const r = planSchedule([printer('a', 0.2, ['asa'])], [plate('x', { dueS: 86400 })], 600)
    expect(r.assignments[0]?.swap).toBe(true)
    expect(r.assignments[0]?.endS).toBe(3600 + 600)
  })
  it('moves to a costlier printer when the cheap one would miss the due date', () => {
    const r = planSchedule([printer('cheap', 0.1, ['pla'], 7200), printer('fast', 0.5, ['pla'])], [plate('x', { dueS: 5400 })], 600)
    expect(r.assignments[0]?.printerId).toBe('fast')
    expect(r.assignments[0]?.onTime).toBe(true)
  })
  it('reports late when no printer can meet the date', () => {
    const r = planSchedule([printer('a', 0.1, ['pla'], 10000)], [plate('x', { dueS: 5000 })], 600)
    expect(r.assignments[0]?.onTime).toBe(false)
  })
  it('serves the earliest due date first and spreads the rest', () => {
    const plates = [plate('late', { dueS: 90000 }), plate('soon', { dueS: 4000 })]
    const r = planSchedule([printer('a', 0.1, ['pla']), printer('b', 0.3, ['pla'])], plates, 600)
    const soon = r.assignments.find((a) => a.plateId === 'soon')
    const late = r.assignments.find((a) => a.plateId === 'late')
    expect(soon?.printerId).toBe('a')
    expect(soon?.startS).toBe(0)
    expect(late?.printerId).toBe('b')
  })
  it('leaves a plate unassigned when no printer is eligible', () => {
    const r = planSchedule([printer('a', 0.1, ['pla'])], [plate('x', { eligible: () => ({ ok: false, needs: [], reason: 'too big' }) })], 600)
    expect(r.assignments).toEqual([])
    expect(r.unassigned[0]?.reason).toContain('too big')
  })
})

describe('spool fit', () => {
  it('passes with margin, warns under the margin, fails when short', () => {
    expect(fitVerdict(100, 200, 10).status).toBe('pass')
    expect(fitVerdict(100, 105, 10).status).toBe('warn')
    expect(fitVerdict(100, 90, 10).status).toBe('fail')
    expect(fitVerdict(100, 90, 10).shortfallG).toBe(20)
  })
  it('uses at least 10 g of margin on small jobs', () => {
    expect(fitVerdict(20, 25, 10).status).toBe('warn')
  })
  it('finds a swap layer, evenly or by layer time', () => {
    expect(swapLayer(100, 0.5)).toBe(50)
    expect(swapLayer(4, 0.5, [1, 1, 1, 1])).toBe(2)
    expect(swapLayer(4, 0.5, [4, 1, 1, 1])).toBe(0)
  })

  // An H2D with one PLA slot, no Spoolman, and a 115 layer plate that needs 200 g.
  async function fit(remainingPct: number | undefined): Promise<FitResult> {
    const info = { id: 'h2d', name: 'H2D', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', filamentSystem: 'ams' }
    const status = { printerId: 'h2d', state: 'idle', nozzles: [], cameraAvailable: false, updatedAt: '', slots: [{ id: 'A1', material: 'PLA', ...(remainingPct === undefined ? {} : { remainingPct }) }] }
    const ctx = {
      kb,
      context: {},
      host: { printers: { list: async () => [info], status: async () => status, callTool: async () => Promise.reject(new Error('no Spoolman')) } },
    } as unknown as ToolContext
    const shared = { machineRates: new Map(), slices: new Map([[1, { plate: 1, result: { layerCount: 115, layerTimeS: [], stats: { filamentG: [200] } } }]]) } as never
    const r = await checkSpoolFit(ctx, shared, { printerId: 'h2d', slotId: 'A1', material: 'PLA' })
    if (typeof r === 'string') throw new Error(r)
    return r
  }

  it('says once that nobody knows what is left, and claims no shortfall, when the AMS has no reading', async () => {
    for (const pct of [undefined, 0, -1]) {
      const r = await fit(pct)
      expect(r.availG).toBeNull()
      expect(r.swapAfterLayer).toBeNull()
      expect(r.advice).toEqual(['The AMS does not know how much is left on slot A1'])
    }
  })

  it('plans a swap for a short spool and says nothing about stock without Spoolman', async () => {
    const r = await fit(5)
    expect(r.status).toBe('fail')
    expect(r.advice).toEqual(['Plan a swap: the spool covers about layer 23 of 115 (grams spread evenly by layer, so check the G-code)', 'Or load a fuller spool before printing'])
  })

  it('names no swap layer when the spool would not last one layer', async () => {
    const r = await fit(1)
    expect(r.advice).toEqual(['Load a fuller spool before printing'])
    expect(r.advice.join(' ')).not.toMatch(/layer 0/)
  })
})

describe('spool inventory', () => {
  const spools: SpoolRec[] = [
    { id: 1, material: 'PLA', name: 'Ink black', color: '#1a1a1f', remainingG: 640, initialG: 1000 },
    { id: 2, material: 'PLA', name: 'Fern', color: '#22c55e', remainingG: 100, initialG: 1000 },
    { id: 3, material: 'PETG', name: 'Harbor blue', color: '#3b82f6', remainingG: 400, initialG: 1000 },
  ]
  const keyOf = (m: string) => m.toLowerCase()
  it('flags a shortfall for a color and asks for a spool', () => {
    const [r] = checkDemand(spools, [{ label: 'hooks', material: 'PLA', color: 'black', grams: 700 }], keyOf, 150)
    expect(r?.status).toBe('short')
    expect(r?.haveG).toBe(640)
    expect(r?.reorderSpools).toBe(1)
  })
  it('counts every color when none is given, and marks tight stock', () => {
    const [r] = checkDemand(spools, [{ label: 'any', material: 'PLA', grams: 700 }], keyOf, 150)
    expect(r?.haveG).toBe(740)
    expect(r?.status).toBe('tight')
  })
  it('says none for a material with no spool', () => {
    expect(checkDemand(spools, [{ label: 'x', material: 'ASA', grams: 10 }], keyOf, 150)[0]?.status).toBe('none')
  })
  it('lists low spools in stock', () => {
    expect(stockRows(spools, keyOf, 150).flatMap((s) => s.lowSpools)).toEqual(['Fern 100 g'])
    expect(colorMatches(spools[0] as SpoolRec, 'black')).toBe(true)
    expect(colorMatches(spools[0] as SpoolRec, '#22c55e')).toBe(false)
  })
})

describe('overnight and energy', () => {
  it('overall is the worst item', () => {
    expect(overall([{ check: 'a', result: 'pass', detail: '' }, { check: 'b', result: 'warn', detail: '' }])).toBe('warn')
    expect(overall([{ check: 'a', result: 'warn', detail: '' }, { check: 'b', result: 'fail', detail: '' }])).toBe('fail')
    expect(overall([])).toBe('pass')
  })
  it('uses the knowledge wattage when present and labels assumptions otherwise', () => {
    const p1s = kb.get('printer', 'bambu_p1s')
    const known = wattsFor(p1s, 'abs')
    expect(known.source).toBe('knowledge')
    expect(known.printing).toBe(140)
    const none = wattsFor(kb.get('printer', 'voron_2_4'), 'abs')
    expect(none.source).toBe('assumption')
    expect(wattsFor(undefined, 'pla').source).toBe('assumption')
    expect(wattsFor(p1s, 'abs', 200).source).toBe('input')
  })
  it('computes kWh and cost', () => {
    const r = energyOf({ timeS: 36000, watts: { printing: 100, heatup: 500, source: 'input', basis: '', sources: [] }, heatupMin: 6, pricePerKwh: 0.2 })
    expect(r.printKwh).toBeCloseTo(1, 6)
    expect(r.heatupKwh).toBeCloseTo(0.05, 6)
    expect(r.cost).toBeCloseTo(0.21, 6)
  })
})

describe('batch a scenarios replay', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
  })
})

describe('batch a app functions', () => {
  it.each(FUNCTION_SCENARIOS.map((s) => [s.id, s] as const))('%s runs as a plain function', async (_id, s) => {
    const runs = await runFunctionScenario(s)
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) expect({ id: s.id, name: r.name, ok: r.result.ok, summary: r.result.summary }).toMatchObject({ ok: !EXPECTED_REFUSALS.has(s.id) })
  })
})
