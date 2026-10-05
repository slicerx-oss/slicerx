// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plans calibration prints from the filament's documented ranges. With
// geometry on the host, sx-geom generates the test models, which are added to
// the project with their per-object and per-height settings. Printing still
// goes through printer.queue and its approval.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill, type ToolContext } from '../../src/tool'
import { arr, geomRun, newObject, num, partFromGeom, rec } from '../geom_common/index'

export const CALIBRATION_TESTS = ['temp-tower', 'flow', 'pressure-advance', 'retraction', 'max-volumetric', 'tolerance', 'shrinkage'] as const
export type CalibrationTest = (typeof CALIBRATION_TESTS)[number]

const TEST_NAMES: Record<CalibrationTest, string> = {
  'temp-tower': 'temperature tower',
  flow: 'flow test',
  'pressure-advance': 'pressure advance',
  retraction: 'retraction',
  'max-volumetric': 'max volumetric speed',
  tolerance: 'tolerance test',
  shrinkage: 'shrinkage test',
}

export interface GeneratedTest {
  test: CalibrationTest
  objects: { id: string; name: string; bboxMm: [number, number, number]; settings: Record<string, unknown> }[]
  ranges: { zFromMm: number; zToMm: number; settings: Record<string, unknown> }[]
  instructions: string[]
  expected: unknown
  notes: string[]
}

/** What the core can and cannot apply for each test's settings. */
export function calibrationNotes(test: CalibrationTest): string[] {
  if (test === 'flow') return ['Each pad carries its own flow ratio and every object on a plate must share settings, so each pad is on its own plate: slice and print them as separate jobs.']
  if (test === 'max-volumetric') return ['The core does not support spiral mode yet, so the volumetric ramp prints as a normal single-wall part and the result is approximate.']
  if (test === 'temp-tower' || test === 'pressure-advance' || test === 'retraction') return ['The per-height settings apply to one object as height ranges.']
  return []
}

/** Generates one test's models and adds them to the project on one plate. */
async function generate(ctx: ToolContext, test: CalibrationTest, params: Record<string, unknown>): Promise<GeneratedTest | null> {
  const project = ctx.project
  const res = await geomRun(ctx, 'calibrate', { test, ...params })
  const out: GeneratedTest = { test, objects: [], ranges: [], instructions: arr(res['instructions']).filter((x): x is string => typeof x === 'string'), expected: res['expected'] ?? null, notes: calibrationNotes(test) }
  out.ranges = arr(res['ranges']).map((r) => ({ zFromMm: num(rec(r)['zFromMm']), zToMm: num(rec(r)['zToMm']), settings: rec(rec(r)['settings']) }))
  const taken = new Set(project?.objects().map((o) => o.id) ?? [])
  for (const [k, o] of arr(res['objects']).entries()) {
    const name = String(rec(o)['name'] ?? `${test}-${k + 1}`)
    const part = partFromGeom(rec(o)['mesh'], name, 1)
    if (!part) continue
    let id = `calib-${name}`
    for (let n = 2; taken.has(id); n++) id = `calib-${name}-${n}`
    taken.add(id)
    const obj = newObject(id, `${TEST_NAMES[test]} ${name.replace(`${test}-`, '').replace(test, '').trim()}`.trim(), [part])
    if (project?.addObject) await project.addObject(obj, [part])
    out.objects.push({ id, name: obj.name, bboxMm: obj.bboxMm, settings: rec(rec(o)['settings']) })
  }
  // One plate per test (flow pads stay apart, see calibrationNotes): gather
  // the test's objects, which addObject put on plates of their own.
  if (project && out.objects.length > 1 && test !== 'flow') {
    const ids = new Set(out.objects.map((o) => o.id))
    const rest = project.plates().filter((p) => !p.items.every((it) => ids.has(it.objectId)))
    const plates = [...rest, { index: 0, items: out.objects.map((o) => ({ objectId: o.id, copies: 1 })) }]
    project.setPlates(plates.map((p, k) => ({ ...p, index: k + 1 })))
  }
  return out
}

function rangeOf(v: unknown): { min: number; max: number; typical?: number } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r['min'] !== 'number' || typeof r['max'] !== 'number') return null
  return typeof r['typical'] === 'number' ? { min: r['min'], max: r['max'], typical: r['typical'] } : { min: r['min'], max: r['max'] }
}

export function createCalibrate() {
  return defineSkill({
    name: 'calibrate',
    version: '0.9.3',
    permission: 'read',
    description:
      'Plan calibration tests for a filament (temperature tower, flow, pressure advance, retraction, max volumetric speed, tolerance, shrinkage) with ranges from the knowledge base, time and filament. With geometry on the host it also generates the test models and adds them to the project, one plate per test, with the per-object and per-height settings to use. Printing goes through printer.queue and its approval.',
    input: z.object({
      material: z.string().describe('Filament id or name'),
      tests: z.array(z.enum(CALIBRATION_TESTS)).min(1),
      vendorMin: z.number().optional().describe('Vendor nozzle range low end in C, from the spool label'),
      vendorMax: z.number().optional().describe('Vendor nozzle range high end in C'),
      addModels: z.boolean().default(true).describe('Generate the test models and add them to the project (needs geometry on the host)'),
    }),
    permissionFor: (i) => (i.addModels ? 'slice' : 'read'),
    args: (i) => `--plan ${i.tests.join(',')} --material ${i.material}${i.addModels ? ' --add-models' : ''}`,
    async run(i, ctx) {
      const doc = ctx.kb.get('filament', i.material) ?? ctx.kb.search(i.material, { kinds: ['filament'], limit: 1 })[0]?.doc
      if (!doc) return { ok: false, summary: `No filament entry for ${i.material}` }
      const temps = rangeOf(doc.data['nozzle_temp_c'])
      const ext = (doc.data['extrusion'] ?? {}) as Record<string, unknown>
      const flow = rangeOf(ext['flow_ratio'])
      const pa = rangeOf((ext['pressure_advance'] as Record<string, unknown> | undefined)?.['direct_drive'])
      const retr = rangeOf((ext['retraction_mm'] as Record<string, unknown> | undefined)?.['direct_drive'])
      const vol = (ext['max_volumetric_speed_mm3s'] ?? {}) as Record<string, unknown>
      const maxVol = rangeOf(vol['standard_hotend'])
      const rows: Cell[][] = []
      const plan: Record<string, unknown>[] = []
      const params = new Map<CalibrationTest, Record<string, unknown>>()
      let minutes = 0
      let grams = 0
      for (const t of i.tests) {
        if (t === 'temp-tower') {
          const lo = i.vendorMin ?? temps?.min ?? 190
          const hi = i.vendorMax ?? temps?.max ?? 230
          const blocks = Math.floor((hi - lo) / 5) + 1
          const m = blocks * 7
          const g = blocks * 2.4
          minutes += m
          grams += g
          rows.push(['temperature tower', `${hi} to ${lo} C, 5 C steps`, `${m} min`, `${Math.round(g)} g`])
          plan.push({ test: t, fromC: hi, toC: lo, stepC: 5, blocks })
          params.set(t, { fromC: hi, toC: lo, stepC: 5 })
        } else if (t === 'flow') {
          const lo = Math.min(0.93, flow?.min ?? 0.93)
          const hi = Math.max(1.01, flow?.max ?? 1.01)
          const n = Math.round((hi - lo) / 0.02) + 1
          minutes += n * 3.6
          grams += n * 1.8
          rows.push(['flow test', `${lo.toFixed(2)} to ${hi.toFixed(2)}, 0.02 steps`, `${Math.round(n * 3.6)} min`, `${Math.round(n * 1.8)} g`])
          plan.push({ test: t, from: lo, to: hi, step: 0.02 })
          params.set(t, { from: lo, to: hi, step: 0.02 })
        } else if (t === 'pressure-advance') {
          const lo = pa?.min ?? 0
          const hi = pa?.max ?? 0.1
          minutes += 12
          grams += 4
          rows.push(['pressure advance', `${lo} to ${hi}`, '12 min', '4 g'])
          plan.push({ test: t, from: lo, to: hi })
          params.set(t, { from: lo, to: hi, step: Math.max(0.001, Math.round(((hi - lo) / 10) * 1000) / 1000) })
        } else if (t === 'max-volumetric') {
          const lo = 5
          const hi = Math.max(lo + 5, Math.ceil((maxVol?.max ?? 20) * 1.3))
          minutes += 20
          grams += 8
          rows.push(['max volumetric speed', `${lo} to ${hi} mm3/s`, '20 min', '8 g'])
          plan.push({ test: t, fromMm3S: lo, toMm3S: hi })
          params.set(t, { fromMm3S: lo, toMm3S: hi, stepMm3S: 1 })
        } else if (t === 'tolerance') {
          minutes += 25
          grams += 9
          rows.push(['tolerance test', '8 mm holes, 0 to 0.5 mm clearance', '25 min', '9 g'])
          plan.push({ test: t, nominalMm: 8, clearancesMm: [0, 0.1, 0.2, 0.3, 0.4, 0.5] })
          params.set(t, {})
        } else if (t === 'shrinkage') {
          minutes += 45
          grams += 12
          rows.push(['shrinkage test', '100 mm arms, 50 mm post', '45 min', '12 g'])
          plan.push({ test: t, armMm: 100, postMm: 50 })
          params.set(t, {})
        } else {
          const lo = retr?.min ?? 0.2
          const hi = retr?.max ?? 1.2
          minutes += 15
          grams += 5
          rows.push(['retraction', `${lo} to ${hi} mm`, '15 min', '5 g'])
          plan.push({ test: t, fromMm: lo, toMm: hi })
          params.set(t, { fromMm: lo, toMm: hi, stepMm: 0.2 })
        }
      }
      const generated: GeneratedTest[] = []
      let modelNote: string | undefined
      if (i.addModels) {
        if (!ctx.host.geom) modelNote = 'Geometry is not available on this host, so the test models were not generated. Use the plan ranges with the slicer\'s own calibration models.'
        else if (!ctx.project?.addObject) modelNote = 'This project cannot take new objects, so the test models were not added.'
        else {
          for (const t of i.tests) {
            ctx.progress(`generating ${TEST_NAMES[t]}`)
            const g = await generate(ctx, t, params.get(t) ?? {})
            if (g) generated.push(g)
          }
        }
      }
      const added = generated.reduce((a, g) => a + g.objects.length, 0)
      const models = generated.map((g) => ({
        test: g.test,
        objects: g.objects,
        ranges: g.ranges,
        instructions: g.instructions,
        expected: g.expected,
        ...(g.notes.length ? { notes: g.notes } : {}),
      }))
      const rangeRows: Cell[][] = generated.flatMap((g) => [
        ...g.ranges.map((r) => [TEST_NAMES[g.test], `z ${r.zFromMm.toFixed(1)} to ${r.zToMm.toFixed(1)} mm`, Object.entries(r.settings).map(([k, v]) => `${k} ${String(v)}`).join(', ')] as Cell[]),
        ...g.objects.filter((o) => Object.keys(o.settings).length).map((o) => [o.name, 'whole object', Object.entries(o.settings).map(([k, v]) => `${k} ${String(v)}`).join(', ')] as Cell[]),
      ])
      const applyNote = generated.length ? ['The models are in the project. Set the per-height and per-object settings listed before slicing; printing goes through printer.queue and its approval.', ...new Set(generated.flatMap((g) => g.notes))].join(' ') : undefined
      return {
        summary: `${rows.map((r) => r[0]).join(' and ')}, ${Math.round(minutes)} min, ${Math.round(grams)} g${added ? `; ${added} model${added === 1 ? '' : 's'} added` : ''}`,
        output: { material: doc.id, plan, minutes: Math.round(minutes), grams: Math.round(grams), sources: doc.sources, ...(models.length ? { models } : {}), ...(modelNote ? { note: modelNote } : {}), ...(applyNote ? { next: applyNote } : {}) },
        display: [
          { kind: 'table', head: ['test', 'range', 'time', 'filament'], rows },
          ...(rangeRows.length ? [{ kind: 'table' as const, head: ['model', 'where', 'settings'], rows: rangeRows }] : []),
          ...(modelNote ?? applyNote ? [{ kind: 'text' as const, text: modelNote ?? applyNote ?? '' }] : []),
        ],
        citations: ctx.kb.cite(doc.sources.slice(0, 4)),
      }
    },
  })
}
