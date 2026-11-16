// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { clearReplayCache, historiesOf, historyFiles, parseHistories, parseTimeline, timelineFiles, timelineOf, type History } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { connect, data, noKernel, noSx, sxBin, text } from './helpers'
import { readZip } from '../src/zip'

const bin = process.env['SLICERX_SX_GEOM_BIN']
// the native exact tests run on an sx-geom with the exact kernel: the binary is asked, since one built without it
// (cargo build -p sx-geom) refuses every brep operation, and they skip saying why
const why = noKernel(bin)
const exact = why === null
const skipped = why ? ` (skipped: ${why})` : ''
afterEach(() => { vi.unstubAllEnvs(); clearReplayCache() })

it('refuses an exact design before creation when the developer opt-in is off', async () => {
  vi.stubEnv('SX_BREP_DEV', '')
  const calls: string[] = []
  const h = await connect({ geomEngine: async (op) => { calls.push(op); throw new Error('kernel must not run') } })
  const result = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toMatch(/exact.*developer|SX_BREP_DEV/i)
  expect(calls).toEqual([])
  const listed = data<{ output: { designs: unknown[] } }>(await h.call('slicerx_design_list')).output
  expect(listed.designs).toEqual([])
})

it('refuses an unavailable exact kernel without creating a mesh design', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: async () => { throw new Error('exact kernel unavailable') } })
  const result = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toContain('exact kernel unavailable')
  const listed = data<{ output: { designs: unknown[] } }>(await h.call('slicerx_design_list')).output
  expect(listed.designs).toEqual([])
})

it('checks a persistent exact engine without allocating a probe body', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  let bodies = 0
  const h = await connect({ geomEngine: async op => {
    if (op === 'brep.count') return { bodies }
    if (op === 'brep.box') return { body: ++bodies, bodySmb: 'probe' }
    throw new Error(`unexpected operation ${op}`)
  } })
  for (let i = 0; i < 2; i++) {
    const result = await h.call('slicerx_design_new', { exact: true })
    expect(result.isError, text(result)).toBeFalsy()
  }
  expect(bodies).toBe(0)
})

it.skipIf(!exact)(`selects the real native exact path and reads back its representation${skipped}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  const created = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(created.isError, text(created)).toBeFalsy()
  // the kernel is asked once, and how detailed a part may grow where each body goes back as text
  expect(calls).toEqual(['brep.count', 'exact.ops'])
  const d = data<{ output: { design: string; exact: boolean; solidLimits?: unknown } }>(created).output
  expect(d.exact).toBe(true)
  expect(d.solidLimits).toEqual({ textChars: 8 * 1024 * 1024, edges: 3300, controlPoints: 178000 })
  const extruded = await h.call('slicerx_geom_extrude', { design: d.design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
  expect(extruded.isError, text(extruded)).toBeFalsy()
  expect(calls).toContain('brep.extrude')
  expect(calls).not.toContain('shape.extrude')
  expect(data<{ output: unknown }>(extruded).output).toMatchObject({ exact: true, sizeMm: [30, 10, 3], volumeMm3: 900 })
}, 25000)

it('preserves required exact intent through history and timeline project metadata', () => {
  const history: History = { version: 1, base: [], steps: [], exact: true }
  const objects = [{ id: 'bracket', history }]
  const ids = new Map([['bracket', 7]])
  const files = (entries: ReturnType<typeof historyFiles>) => new Map(entries.map(e => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
  expect(parseHistories(files(historyFiles(objects, ids)), new Set(['7'])).get('7')?.exact).toBe(true)
  const timeline = parseTimeline(files(timelineFiles(timelineOf(objects), ids)), new Set(['7']))!
  expect(historiesOf(timeline).get('7')?.exact).toBe(true)
})

it('refuses damaged required exact histories instead of opening their saved meshes', () => {
  const ids = new Set(['7'])
  const files = (value: unknown) => new Map([['Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(value))]])
  const body = { object: '7', base: null, exact: true }
  const damaged = files({ version: 2, objects: [{ ...body, steps: [{ params: { op: 'unknown' } }] }] })
  expect(() => parseHistories(damaged, ids)).toThrow(/required exact history.*not opened as a mesh/)
  const timeline = files({ version: 3, bodies: [body], items: [{ kind: 'feature', body: '7', params: { op: 'unknown' } }], marker: 1 })
  expect(() => parseHistories(timeline, ids)).toThrow(/required exact history/)
  expect(() => parseTimeline(timeline, ids)).toThrow(/required exact history/)
  const future = files({ version: 99, objects: [{ ...body, steps: [] }] })
  expect(() => parseHistories(future, ids)).toThrow(/required exact history/)
})

it.skipIf(!exact)(`keeps exact history and redo intact when an edit or redo fails${skipped}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  let refuse = false
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => {
    if (refuse && op === 'brep.extrude') throw new Error('injected exact failure')
    return native(op, request)
  } })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await h.call(name, args)
    expect(result.isError, text(result)).toBeFalsy()
    return data<{ output: Record<string, unknown> }>(result).output
  }
  const d = (await ok('slicerx_design_new', { exact: true })).design as string
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, distance_mm: 3 })
  const before = await ok('slicerx_design_steps', { design: d })
  refuse = true
  const edited = await h.call('slicerx_design_edit_step', { design: d, step: 1, value: 6 })
  expect(edited.isError).toBe(true)
  expect(text(edited)).toContain('injected exact failure')
  expect(await ok('slicerx_design_steps', { design: d })).toEqual(before)
  const empty = await ok('slicerx_design_undo', { design: d })
  expect(empty.stlPath).toBeUndefined()
  clearReplayCache()
  const redone = await h.call('slicerx_design_redo', { design: d })
  expect(redone.isError).toBe(true)
  expect(text(redone)).toContain('injected exact failure')
  expect((await ok('slicerx_design_steps', { design: d })).steps).toEqual([])
  refuse = false
  expect(await ok('slicerx_design_redo', { design: d })).toMatchObject({ exact: true, volumeMm3: 900, steps: 1 })
  const unsupported = await h.call('slicerx_geom_hollow', { design: d, wall_mm: 1 })
  expect(unsupported.isError).toBe(true)
  expect(text(unsupported)).toMatch(/exact|support/i)
  expect((await ok('slicerx_design_steps', { design: d })).steps).toHaveLength(1)
}, 40000)

it.skipIf(!exact || noSx())(`replays an exact bracket hole edit through a later cut, project reopen and real slicing${skipped}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ engine: 'sx', sxBin, geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  interface Summary {
    design: string; exact: boolean; steps: number; stlPath: string
    parts: { sizeMm: number[]; volumeMm3: number }[]
  }
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const d = (await ok<Summary>('slicerx_design_new', { name: 'Exact bracket', exact: true })).design
  const rectangle = (w: number, h: number, center: number[], distance: number) => ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: w, heightMm: h }, placement: { center }, distance_mm: distance })
  await rectangle(30, 10, [15, 5], 3)
  await rectangle(10, 30, [5, 15], 3)
  await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1] })
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 3 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, placement: { center: [5, 5] }, distance_mm: 3, operation: 'cut' })
  await ok('slicerx_geom_hole_edit', { design: d, center: [5, 5, 3], axis: [0, 0, -1], diameter_mm: 4 })
  await rectangle(6, 8, [50, 5], 4)
  await ok('slicerx_geom_cut', { design: d, part: 0, plane: { axis: 'z', at: 2 }, keep: 'below' })
  const diameter = async (design: string, diameter: number) => {
    const r = await ok<{ measurement: { diameterMm?: number; radiusMm?: number } }>('slicerx_geom_measure', { design, a: { at: [5 + diameter / 2, 5, 1], normal: [-1, 0, 0] } })
    expect(r.measurement.diameterMm ?? (r.measurement.radiusMm ?? 0) * 2).toBeCloseTo(diameter, 1)
  }
  await diameter(d, 4)
  const edited = await ok<Summary>('slicerx_design_edit_step', { design: d, step: 5, value: 6 })
  const verify = (s: Summary, height: number) => {
    expect(s.exact).toBe(true)
    expect(s.parts).toHaveLength(2)
    expect(s.parts[0]!.sizeMm).toEqual([30, 30, height])
    expect(Math.abs(s.parts[0]!.volumeMm3 - (500 - Math.PI * 9) * height)).toBeLessThan(0.5)
    expect(s.parts[1]).toMatchObject({ sizeMm: [6, 8, 4], volumeMm3: 192 })
  }
  verify(edited, 2)
  await diameter(d, 6)
  // feature undo removes the downstream cut; parameter undo needs the separate app gate
  verify(await ok<Summary>('slicerx_design_undo', { design: d }), 3)
  verify(await ok<Summary>('slicerx_design_redo', { design: d }), 2)
  const saved = await ok<{ path: string }>('slicerx_design_save', { design: d })
  clearReplayCache()
  const reopened = (await ok<{ designs: Summary[] }>('slicerx_design_open', { path: saved.path })).designs[0]!
  verify(reopened, 2)
  expect(reopened.steps).toBe(7)
  await diameter(reopened.design, 6)
  expect(calls).toEqual(expect.arrayContaining(['brep.extrude', 'brep.boolean', 'brep.hole', 'brep.cut']))
  expect(calls).not.toEqual(expect.arrayContaining(['shape.extrude']))
  const sliced = await h.call('slicerx_slice_file', { model: reopened.stlPath, profiles: ['machine:bambu-a1', 'stock-filament:BBL/Bambu PLA Basic @BBL A1', 'process:standard'], output: 'gcode.3mf' })
  expect(sliced.isError, text(sliced)).toBeFalsy()
  const result = data<{ gcode_3mf_path: string; filament_g: number }>(sliced)
  expect(result.filament_g).toBeGreaterThan(0)
  const gcode = readZip(readFileSync(result.gcode_3mf_path)).text('Metadata/plate_1.gcode')
  expect(gcode).toMatch(/G1 .*E[0-9]/)
  vi.stubEnv('SX_BREP_DEV', '')
  const refused = await h.call('slicerx_design_open', { path: saved.path })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('SX_BREP_DEV')
  const listed = await ok<{ designs: unknown[] }>('slicerx_design_list', {})
  expect(listed.designs).toHaveLength(2)
}, 120000)

it.skipIf(!exact)(`cuts every exact part of a design that must stay exact when geom.subtract names no part, and keeps a part the cutters miss${skipped}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  interface Summary { exact: boolean; steps: number; parts: { sizeMm: number[]; volumeMm3: number }[] }
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const d = (await ok('slicerx_design_new', { name: 'Two blocks', exact: true }) as unknown as { design: string }).design
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [60, 5] }, distance_mm: 3 })
  calls.length = 0
  // a row of two 4 mm holes through the first block only: the second block is missed and kept as it is
  const holes = [5, 25].map((x) => ({ type: 'cylinder', origin: [x, 5, -1], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }))
  const cut = await ok('slicerx_geom_subtract', { design: d, solids: holes })
  expect(cut.exact).toBe(true)
  expect(calls.filter((op) => op === 'brep.subtract')).toHaveLength(2)
  expect(calls).not.toContain('subtract')
  expect(cut.parts).toHaveLength(2)
  // the round holes are faceted only when tessellated, so the volume is within the tessellation's chord of the true one
  expect(Math.abs(cut.parts[0]!.volumeMm3 - (900 - 2 * Math.PI * 4 * 3))).toBeLessThan(0.5)
  expect(cut.parts[1]).toMatchObject({ sizeMm: [10, 10, 3], volumeMm3: 300 })
  // cutters that miss every part: the step is refused, and the design is as it was
  const missed = await h.call('slicerx_geom_subtract', { design: d, solids: [{ type: 'cylinder', origin: [200, 200, -1], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }] })
  expect(missed.isError).toBe(true)
  expect(text(missed)).toContain('The shape no longer reaches the part')
  expect((await ok('slicerx_design_steps', { design: d }) as unknown as { steps: unknown[] }).steps).toHaveLength(3)
}, 40000)

it.skipIf(!exact)(`mirrors a box cut on the exact kernel, on one part and on every part, and the parts stay exact${skipped}`, async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  for (const part of [0, undefined]) {
    clearReplayCache()
    const calls: string[] = []
    const native = geomEngine(bin!, 20000)
    const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
    interface Summary { exact: boolean; parts: { sizeMm: number[]; volumeMm3: number }[] }
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Two blocks', exact: true }) as unknown as { design: string }).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [60, 5] }, distance_mm: 3 })
    // a 4 x 4 mm slot through one end of the first block, then its mirror image through x = 15 at the other end
    await ok('slicerx_geom_subtract', { design: d, solids: [{ type: 'box', min: [2, 3, -1], max: [6, 7, 4] }], ...(part === undefined ? {} : { part }) })
    calls.length = 0
    const both = await ok('slicerx_geom_mirror', { design: d, plane: { axis: 'x', at: 15 }, steps: [3] })
    expect(both.exact).toBe(true)
    expect(calls).toContain('brep.subtract')
    expect(calls).not.toContain('subtract')
    // flat faces only, so the volumes are the true ones: two slots of 48 mm3 out of 900, and the second block missed
    expect(both.parts[0]!.volumeMm3).toBeCloseTo(900 - 2 * 48, 6)
    expect(both.parts[1]).toMatchObject({ sizeMm: [10, 10, 3], volumeMm3: 300 })
  }
}, 60000)
