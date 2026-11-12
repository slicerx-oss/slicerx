// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up reshapes a lofted body by its sections: design.edit_step's section edit makes one station fuller or
// finer, moves it, adds or takes out a station, raises a line toward the ends or leans an end out, on a pod, a car
// body and a bottle alike. What stood on the body is re-seated on its new top at the steps that made it, and the answer
// says plainly when a part now hangs past the edge or when an end now needs supports, keeping the edit as asked.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'
import { bodyOf, sectionEdited, SHAPE_WORDS, type SectionEdit } from '../src/section-edit'
import type { Step } from '@slicerx/cad-history'

type V3 = [number, number, number]
interface Part {
  name: string
  minMm: V3
  sizeMm: V3
  paintedTriangles?: Record<string, number>
}
interface Row {
  state: string
  message?: string
  stations?: { station: number; at: number; width: number; height: number; name?: string }[]
}
interface Summary {
  design: string
  sizeMm: V3
  parts: Part[]
  steps: Row[]
  shapeWords?: typeof SHAPE_WORDS
  warnings?: string[]
  moved?: string[]
}

const geom = useGeomEngine('design-section-edit')

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    return { r, out: data<{ ok?: boolean; summary: string; output: Summary }>(r) }
  }
  const ok = async (name: string, args: Record<string, unknown>) => {
    const { r, out } = await call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    expect(out.ok, `${name}: ${text(r)}`).not.toBe(false)
    return out
  }
  return { call, ok }
}

const r1 = (n: number) => Math.round(n * 10) / 10

// a pod section: half-breadth w, height h, a flat top closing it
const podSection = (w: number, h: number): [number, number][] => [[w, h], [w * 0.95, h * 0.5], [w * 0.7, h * 0.1], [0, 0], [-w * 0.7, h * 0.1], [-w * 0.95, h * 0.5], [-w, h]]
const across = (x: number) => ({ origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] })
// the pod runs along x, its fine end (the front) at x 0
const POD = [[0, 4], [30, 10], [60, 12], [90, 11], [120, 8]].map(([x, w]) => ({ frame: across(x!), loops: [{ points: podSection(w!, 10) }] }))

// a car body: chamfered boxes along y, the low nose at y 0
const carSection = (w: number, h: number): [number, number][] => [[-w / 2 + 1, 0], [w / 2 - 1, 0], [w / 2, 3], [w / 2, h - 3], [w / 2 - 3, h], [-w / 2 + 3, h], [-w / 2, h - 3], [-w / 2, 3]]
const along = (y: number) => ({ origin: [0, y, 0], normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] })
const CAR = [[0, 34, 10], [20, 40, 14], [50, 40, 22], [80, 40, 20], [100, 36, 16]].map(([y, w, h]) => ({ frame: along(y!), loops: [{ points: carSection(w!, h!) }] }))

// a bottle standing on the bed: round sections up z, the neck at the top
const ring = (r: number): [number, number][] => Array.from({ length: 16 }, (_, k) => [r * Math.cos((k * Math.PI) / 8), r * Math.sin((k * Math.PI) / 8)] as [number, number])
const level = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const BOTTLE = [[0, 15], [40, 16], [55, 12], [65, 6], [80, 6]].map(([z, r]) => ({ frame: level(z!), loops: [{ points: ring(r!) }] }))

const loftStep = (profiles: unknown[]): Step => ({ id: 's1', part: 0, params: { op: 'sketch.loft', profiles, name: 'Body' }, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as unknown as Step

describe('the section edit, read from the sections', () => {
  it('names the stations front to back on all three bodies', () => {
    const pod = bodyOf(loftStep(POD))
    const car = bodyOf(loftStep(CAR))
    const bottle = bodyOf(loftStep(BOTTLE))
    if (typeof pod === 'string' || typeof car === 'string' || typeof bottle === 'string') throw new Error('no body')
    // the fine end is the front of the pod and the car; the top is the front of a standing bottle
    expect(pod.stations.map((s) => r1(s.t))).toEqual([0, 30, 60, 90, 120])
    expect(car.stations.map((s) => r1(s.t))).toEqual([0, 20, 50, 80, 100])
    expect(bottle.stations.map((s) => r1(s.t))).toEqual([80, 65, 55, 40, 0])
    expect(bottle.upright).toBe(true)
  })

  it('answers every entry of the words table on the pod and the car, and on the bottle or says why not', () => {
    for (const [name, profiles] of [['pod', POD], ['car', CAR], ['bottle', BOTTLE]] as const) {
      for (const entry of SHAPE_WORDS.words) {
        const r = sectionEdited(loftStep(profiles as unknown[]), entry.edit as SectionEdit)
        const upright = name === 'bottle'
        const lying = 'line' in entry.edit || 'end' in entry.edit || 'flatten' in entry.edit
        if (upright && lying) expect(r, `${name}: ${entry.say[0]}`).toMatch(/standing body/)
        else expect(typeof r, `${name}: ${entry.say[0]}: ${String(r)}`).toBe('object')
      }
    }
  })

  it('takes pod, car and bottle words for the generic names', () => {
    const front = sectionEdited(loftStep(POD), { station: 'nose', scale: { width: 1.25 } })
    const nose = sectionEdited(loftStep(CAR), { station: 'nose', scale: { width: 1.25 } })
    const shoulder = sectionEdited(loftStep(BOTTLE), { station: 'shoulder', scale: 1.15 })
    if (typeof front === 'string' || typeof nose === 'string' || typeof shoulder === 'string') throw new Error(`refused: ${String(front)} ${String(nose)} ${String(shoulder)}`)
    expect(front.said[0]).toBe('station 1 (front) 8 to 10 mm wide')
    expect(nose.said[0]).toBe('station 1 (front) 34 to 42.5 mm wide')
    // the shoulder is the station just above the widest
    expect(shoulder.said[0]).toBe('station 3 24 to 27.6 mm wide, 24 to 27.6 mm deep')
    const top = sectionEdited(loftStep(POD), { line: { which: 'roofline', front: 4 } })
    if (typeof top === 'string') throw new Error(top)
    expect(top.said[0]).toBe('the top line rises 4 mm at the front, eased toward the middle')
  })

  it('refuses a station that is not there, naming the ones that are', () => {
    expect(sectionEdited(loftStep(POD), { station: 9, width: 10 })).toMatch(/has 5 stations, 1 \(front\) to 5 \(back\)/)
    expect(sectionEdited(loftStep(POD), { station: 'handle', width: 10 })).toMatch(/"handle" is no station/)
    expect(sectionEdited(loftStep(POD), { add: 200 })).toMatch(/not between two stations/)
  })
})

describe('design.edit_step section', () => {
  it('makes the nose of a pod fuller, adds and removes a station, and lists the stations', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Pod' })).output.design
    await ok('slicerx_geom_loft', { design: d, profiles: POD, name: 'Body' })
    const steps = await ok('slicerx_design_steps', { design: d })
    expect(steps.output.steps[0]!.stations!.map((s) => s.width)).toEqual([8, 20, 24, 22, 16])
    expect(steps.output.shapeWords?.names.front).toContain('nose')
    const fuller = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'nose', scale: { width: 1.25 } } })
    expect(fuller.summary).toBe('Edited step 1, Loft, 5 profiles: station 1 (front) 8 to 10 mm wide')
    expect(fuller.output.steps[0]!.stations![0]!.width).toBe(10)
    const added = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { add: 45 } })
    expect(added.output.steps[0]!.stations!.map((s) => s.at)).toEqual([0, 30, 45, 60, 90, 120])
    expect(added.output.steps[0]!.stations![2]!.width).toBe(22)
    const removed = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { remove: 3 } })
    expect(removed.output.steps[0]!.stations!.length).toBe(5)
    expect(removed.output.steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('lowers a pod: the top joined on it and the cab standing on it come down with it, the band paint stays', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Pod' })).output.design
    await ok('slicerx_geom_loft', { design: d, profiles: POD, name: 'Body' })
    await ok('slicerx_geom_extrude', { design: d, part: 0, operation: 'join', frame: { origin: [30, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 8 }, distance_mm: 2 })
    await ok('slicerx_geom_extrude', { design: d, operation: 'new', frame: { origin: [80, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 6, name: 'Cab' })
    const pv = await ok('slicerx_paint_preview', { design: d, layer: 'color', state: 2, target: { kind: 'height', below: 3 }, part: 0 })
    await ok('slicerx_paint_apply', { preview: (pv.output as unknown as { preview: string }).preview })
    const lower = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'all', scale: { height: 0.7 } } })
    expect(lower.summary).toContain('every station 70% as tall')
    expect(lower.summary).toContain('re-seated on the new top of Body: step 2')
    expect(lower.summary).toContain('down 3 mm, Cab down 3 mm')
    const [pod, cab] = lower.output.parts
    expect(r1(pod!.sizeMm[2])).toBe(9)
    expect(r1(cab!.minMm[2])).toBe(7)
    expect(Object.values(pod!.paintedTriangles ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(lower.output.steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('says plainly that a cab now hangs past the side of a pod made narrower than it', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Pod' })).output.design
    await ok('slicerx_geom_loft', { design: d, profiles: POD, name: 'Body' })
    await ok('slicerx_geom_extrude', { design: d, operation: 'new', frame: { origin: [60, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 16 }, distance_mm: 6, name: 'Cab' })
    const narrow = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'all', scale: { width: 0.5 } } })
    expect(narrow.summary).toMatch(/Cab now hangs \d+(\.\d)? mm past the edge of Body: move or resize it, or edit the station under it/)
    expect(narrow.output.warnings?.some((w) => w.startsWith('Cab now hangs'))).toBe(true)
    // still standing on the top it had: not lifted, not buried
    expect(r1(narrow.output.parts[1]!.minMm[2])).toBe(10)
  })

  it('leans the nose of a car out: a little prints clean, past 45 degrees it says supports and keeps the edit', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Toy car' })).output.design
    await ok('slicerx_geom_loft', { design: d, profiles: CAR, name: 'Body' })
    const longer = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'nose', outBy: 0.1 } })
    expect(longer.summary).toBe('Edited step 1, Loft, 5 profiles: station 1 (front) moved 10 mm out along y')
    expect(r1(longer.output.parts[0]!.minMm[1])).toBe(-10)
    // the body stands on the bed, its roof up
    expect(r1(longer.output.parts[0]!.minMm[2])).toBe(0)
    expect(r1(longer.output.parts[0]!.sizeMm[2])).toBe(22)
    const raked = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { end: { which: 'nose', lean: 20 } } })
    expect(raked.summary).toContain('the front leans 20 degrees out (was 0)')
    expect(raked.summary).not.toContain('supports')
    const steep = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { end: { which: 'front', lean: 60 } } })
    expect(steep.summary).toContain('the front leans 60 degrees out (was 20)')
    expect(steep.summary).toMatch(/Body now needs supports: about \d+ mm² more of it faces down steeper than 45 degrees, where it printed without supports before\. Kept as asked/)
    expect(steep.output.steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('makes the shoulder of a bottle fuller and lifts the cap on its neck when the neck moves up', async () => {
    const { ok, call } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Bottle' })).output.design
    await ok('slicerx_geom_loft', { design: d, profiles: BOTTLE, name: 'Bottle' })
    await ok('slicerx_geom_extrude', { design: d, operation: 'new', frame: level(80), shape: { type: 'circle', diameterMm: 12 }, distance_mm: 8, name: 'Cap' })
    const fuller = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'shoulder', scale: 1.15 } })
    expect(fuller.summary).toBe('Edited step 1, Loft, 5 profiles: station 3 24 to 27.6 mm wide, 24 to 27.6 mm deep')
    const taller = await ok('slicerx_design_edit_step', { design: d, step: 1, section: { station: 'neck', out: 6 } })
    expect(taller.summary).toContain('station 1 (front) moved 6 mm out along z')
    expect(taller.summary).toContain('Cap up 6 mm')
    expect(r1(taller.output.parts[1]!.minMm[2])).toBe(86)
    // a standing body has no end to lean: it says so rather than guess
    const lean = await call('slicerx_design_edit_step', { design: d, step: 1, section: { end: { which: 'front', lean: 20 } } })
    expect(text(lean.r)).toContain('the ends of a standing body are its top and base')
  })
})
