// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plain slice picks its plate with plate_type, by the names the app's plate pickers show, and the G-code heats the
// bed to that plate's first layer and other layer temperatures. A client checks it the way a person would: by the
// M140 and M190 the G-code sends.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SliceJob } from '../src/slicer'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text, type Harness } from './helpers'

const A1_PETG = ['machine:bambu-a1', 'stock-filament:BBL/Bambu PETG Basic @BBL A1']

/** The plate names a client passes, the engine's name for each, and the settings key of its temperatures. */
const PLATES: readonly [string, string, string][] = [
  ['Textured PEI', 'Textured PEI Plate', 'textured_plate_temp'],
  ['Smooth PEI', 'High Temp Plate', 'hot_plate_temp'],
  ['Cool plate', 'Cool Plate', 'cool_plate_temp'],
  ['Engineering plate', 'Engineering Plate', 'eng_plate_temp'],
  ['High temp plate', 'High Temp Plate', 'hot_plate_temp'],
  ['Textured cool plate', 'Textured Cool Plate', 'textured_cool_plate_temp'],
  ['Supertack plate', 'Supertack Plate', 'supertack_plate_temp'],
]

const NAMES = 'Textured PEI, Smooth PEI, Cool plate, Engineering plate, High temp plate, Textured cool plate, Supertack plate'

/**
 * The bed temperatures a G-code sends: `start`, every M140 and M190 before the first layer, and `later`, the one in
 * force at the end of the second layer.
 */
function beds(gcode: string): { start: { cmd: string; s: number }[]; later: number | undefined } {
  const start: { cmd: string; s: number }[] = []
  let layer = -1
  let later: number | undefined
  for (const line of gcode.split('\n')) {
    const t = line.trim()
    if (t.startsWith('; CHANGE_LAYER') || t.startsWith(';LAYER_CHANGE')) {
      layer++
      if (layer === 2) break
      continue
    }
    const [cmd, arg] = t.split(';')[0]!.trim().split(/\s+/)
    if ((cmd === 'M140' || cmd === 'M190') && arg?.startsWith('S')) {
      const s = Number(arg.slice(1))
      if (layer < 0) start.push({ cmd, s })
      later = s
    }
  }
  return { start, later }
}

const first = (v: unknown): number => Number(Array.isArray(v) ? v[0] : v)

/** Slices the cube with the sx engine and gives the answer, the request the engine got and the G-code. */
async function slice(h: Harness, args: Record<string, unknown>): Promise<{ r: Awaited<ReturnType<Harness['call']>>; job: SliceJob; gcode: string }> {
  const spy = vi.spyOn(h.ctx.slicer!, 'slice')
  const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profiles: A1_PETG, ...args })
  expect(r.isError, text(r)).toBeFalsy()
  const job = spy.mock.calls.at(-1)![0]
  spy.mockRestore()
  return { r, job, gcode: readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8') }
}

describe.skipIf(noSx())('plate_type on a plain slice, A1 with Bambu PETG Basic', { timeout: sxTimeout }, () => {
  for (const [name, engine, key] of PLATES) {
    it(`${name} heats the bed to that plate's temperatures`, async () => {
      const h = await connect({ engine: 'sx', sxBin })
      try {
        const { r, job, gcode } = await slice(h, { plate_type: name })
        expect(job.explicitConfig['curr_bed_type']).toBe(engine)
        // The filament's own temperatures for the plate. A filament with 0 for a plate does not support it: the bed
        // heats as on the high temp plate, and the answer warns.
        const own = { first: first(job.explicitConfig[`${key}_initial_layer`]), other: first(job.explicitConfig[key]) }
        expect(Number.isFinite(own.first) && Number.isFinite(own.other), `${key} in the request`).toBe(true)
        const hot = { first: first(job.explicitConfig['hot_plate_temp_initial_layer']), other: first(job.explicitConfig['hot_plate_temp']) }
        const want = own.other > 0 ? { first: own.first > 0 ? own.first : own.other, other: own.other } : hot
        const b = beds(gcode)
        expect(b.start.map((x) => x.cmd), 'the start G-code heats and waits').toEqual(expect.arrayContaining(['M140', 'M190']))
        expect(b.start.map((x) => x.s)).toEqual(b.start.map(() => want.first))
        expect(b.later).toBe(want.other)
        if (own.other <= 0) expect(data<{ warnings: string[] }>(r).warnings.join('\n')).toMatch(/no bed temperature for the Cool Plate/)
        expect(text(r)).toContain(`Plate type: ${name}`)
        expect(data<{ plate_type?: string }>(r).plate_type).toBe(name)
      } finally { await h.client.close() }
    })
  }

  it('each name picks its own plate, with a temperature of its own per plate', async () => {
    // Every plate's keys set apart, so a name that picked another plate's keys would show.
    const temps: Record<string, [number, number]> = { cool_plate_temp: [41, 42], eng_plate_temp: [51, 52], hot_plate_temp: [61, 62], textured_plate_temp: [71, 72], supertack_plate_temp: [81, 82], textured_cool_plate_temp: [45, 46] }
    const overrides = Object.fromEntries(Object.entries(temps).flatMap(([k, [f, o]]) => [[`${k}_initial_layer`, [f]], [k, [o]]]))
    const h = await connect({ engine: 'sx', sxBin })
    try {
      for (const [name, , key] of PLATES) {
        const b = beds((await slice(h, { plate_type: name, overrides })).gcode)
        expect([...new Set(b.start.map((x) => x.s)), b.later], name).toEqual(temps[key])
      }
    } finally { await h.client.close() }
  })

  it('takes a name in any letter case, without "plate" and in the app\'s own spelling', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      for (const name of ['textured pei', 'SUPERTACK', 'textured-cool', 'High Temp Plate']) {
        const { job } = await slice(h, { plate_type: name })
        expect(job.explicitConfig['curr_bed_type'], name).toBe({ 'textured pei': 'Textured PEI Plate', SUPERTACK: 'Supertack Plate', 'textured-cool': 'Textured Cool Plate', 'High Temp Plate': 'High Temp Plate' }[name])
      }
    } finally { await h.client.close() }
  })

  it('without plate_type slices as before: no plate type sent, no notice', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const { r, job, gcode } = await slice(h, {})
      expect(job.explicitConfig['curr_bed_type']).toBeUndefined()
      expect(data<{ plate_type?: string; notices?: unknown[] }>(r).plate_type).toBeUndefined()
      expect(data<{ notices?: unknown[] }>(r).notices ?? []).toEqual([])
      expect(text(r)).not.toContain('Plate type:')
      const b = beds(gcode)
      expect(b.start.length).toBeGreaterThan(0)
    } finally { await h.client.close() }
  })
})

describe('a plate_type no plate has', () => {
  it('is refused with the names a client can pass', async () => {
    const h = await connect()
    try {
      for (const tool of ['slicerx_slice_file', 'slicerx_estimate_file']) {
        const r = await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], plate_type: 'Glass' })
        expect(r.isError, tool).toBe(true)
        expect(text(r)).toBe(`Error: invalid_input: plate_type: no plate is called "Glass". Use one of: ${NAMES}.`)
        expect((r.structuredContent as { error?: { code?: string } }).error?.code).toBe('invalid_input')
      }
    } finally { await h.client.close() }
  })

  it('an empty name is refused too', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), plate_type: '  ' })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain(`Use one of: ${NAMES}.`)
    } finally { await h.client.close() }
  })
})

describe('plate_type and the other places a plate type comes from', () => {
  /** A P1S project with one box, its plate set to `plate`, its settings to `bed`. */
  function project(path: string, plate: string, bed: string): string {
    const box = '<object id="1" name="Box" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="20"/><vertex x="20" y="0" z="20"/><vertex x="20" y="20" z="20"/><vertex x="0" y="20" z="20"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="3" v2="7" v3="6"/><triangle v1="3" v2="6" v3="2"/><triangle v1="0" v2="4" v3="7"/><triangle v1="0" v2="7" v3="3"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/></triangles></mesh></object>'
    writeFileSync(path, writeZip([
      { name: '3D/3dmodel.model', data: `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${box}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>` },
      { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="Box"/><metadata key="extruder" value="1"/></object><plate><metadata key="plater_id" value="1"/><metadata key="bed_type" value="${plate}"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>` },
      { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2', filament_colour: ['#FFFFFF'], filament_type: ['PLA'], curr_bed_type: bed }) },
    ]))
    return path
  }

  /** The `curr_bed_type` of the request slicerx_slice_file sends with `args`. */
  async function sent(h: Harness, args: Record<string, unknown>): Promise<unknown> {
    // The stub engine reads STL only, so it refuses a 3MF once it has the request; the request is what counts here.
    const spy = vi.spyOn(h.ctx.slicer!, 'slice')
    await h.call('slicerx_slice_file', args)
    expect(spy).toHaveBeenCalledTimes(1)
    const v = spy.mock.calls[0]![0].config['curr_bed_type']
    spy.mockRestore()
    return v
  }

  it("goes over a project plate's own plate type and the project's", async () => {
    const h = await connect()
    try {
      const model = project(join(h.dir, 'p.3mf'), 'Cool Plate', 'Engineering Plate')
      expect(await sent(h, { model, profiles: ['machine:bambu-p1s'], project_settings: true })).toBe('Cool Plate')
      expect(await sent(h, { model, profiles: ['machine:bambu-p1s'], project_settings: true, plate_type: 'Supertack plate' })).toBe('Supertack Plate')
    } finally { await h.client.close() }
  })

  it('a curr_bed_type override is refused and points at plate_type', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { curr_bed_type: 'Cool Plate' } })
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(`Error: invalid_settings: overrides: set the plate type with plate_type, not curr_bed_type. Use one of: ${NAMES}.`)
      expect((r.structuredContent as { error?: { code?: string } }).error?.code).toBe('invalid_settings')
    } finally { await h.client.close() }
  })

  it('slicerx_estimate_file takes it too', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], plate_type: 'Cool plate' })
      expect(r.isError, text(r)).toBeFalsy()
      expect(data<{ notices?: { code: string }[] }>(r).notices ?? []).toEqual([])
    } finally { await h.client.close() }
  })
})
