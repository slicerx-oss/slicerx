// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client lists, adds and removes the pauses, color changes and custom G-code of a 3MF project's plate through the
// server, as an outside client does: custom G-code waits for the user's approval, and the saved project reads back
// with the reader the app opens projects with (@slicerx/threemf/layer-marks, called by import3mf.ts).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { readLayerMarks } from '@slicerx/threemf/layer-marks'
import { readZip, writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const BOX = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`

interface Mark {
  z_mm: number
  kind: string
  gcode?: string
  slot?: number
  refused?: string
}

const marksOf = (path: string) => {
  const xml = readZip(readFileSync(path)).text('Metadata/custom_gcode_per_layer.xml')
  return xml === undefined ? undefined : readLayerMarks(xml)
}

async function harness(opts: Parameters<typeof connect>[0] = {}, client: Parameters<typeof connect>[1] = {}) {
  const h = await connect(opts, client)
  const path = join(h.dir, 'box.3mf')
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: BOX }]))
  const list = async () => data<{ output?: unknown; marks: Mark[] }>(await h.call('slicerx_project_layer_marks', { project: path })).marks
  return { h, path, list }
}

describe('layer mark tools, as a client drives them', () => {
  it('lists the three tools with their permission', async () => {
    const { h } = await harness()
    const tools = (await h.client.listTools()).tools
    const add = tools.find((t) => t.name === 'slicerx_project_layer_mark_add')
    expect(add?.description).toContain('Permission class: slice')
    expect(add?.annotations?.readOnlyHint).toBe(false)
    expect(tools.find((t) => t.name === 'slicerx_project_layer_marks')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.some((t) => t.name === 'slicerx_project_layer_mark_remove')).toBe(true)
  })

  it('adds a pause and a color change, lists them, removes one, and the app reads the saved marks back', async () => {
    const { h, path, list } = await harness()
    expect(await list()).toEqual([])
    const pause = await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 4, kind: 'pause' })
    expect(pause.isError, text(pause)).toBeFalsy()
    expect(data<{ output: { mark: Mark; marks: Mark[] } }>(pause).output.mark).toEqual({ z_mm: 4, kind: 'pause' })
    const change = await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 6.2, kind: 'color_change', slot: 2 })
    expect(data<{ output: { marks: Mark[] } }>(change).output.marks).toEqual([{ z_mm: 4, kind: 'pause' }, { z_mm: 6.2, kind: 'color_change', slot: 2 }])
    expect(await list()).toEqual([{ z_mm: 4, kind: 'pause' }, { z_mm: 6.2, kind: 'color_change', slot: 2 }])
    expect(marksOf(path)).toEqual({ 0: [{ z: 4, kind: 'pause' }, { z: 6.2, kind: 'color_change', slot: 2 }] })

    const removed = await h.call('slicerx_project_layer_mark_remove', { project: path, z_mm: 4 })
    expect(removed.isError, text(removed)).toBeFalsy()
    expect(data<{ output: { removed: Mark } }>(removed).output.removed).toEqual({ z_mm: 4, kind: 'pause' })
    expect(await list()).toEqual([{ z_mm: 6.2, kind: 'color_change', slot: 2 }])
    expect(marksOf(path)).toEqual({ 0: [{ z: 6.2, kind: 'color_change', slot: 2 }] })
    await h.call('slicerx_project_layer_mark_remove', { project: path, z_mm: 6.2 })
    expect(marksOf(path)).toBeUndefined()
  })

  it('refuses custom G-code until the user approves it, and saves it once they do', async () => {
    const { h, path, list } = await harness()
    const gcode = 'M117 Swap the insert\nG4 P2000'
    const asked = await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 5, kind: 'custom', gcode })
    const req = data<{ status: string; request_id: string; title: string; lines: string[] }>(asked)
    expect(req.status).toBe('approval_required')
    expect(req.title).toBe('Add custom G-code at 5 mm on plate 1 of box.3mf?')
    expect(req.lines).toEqual(['Inserts this G-code at the start of that layer when the project is sliced:', 'M117 Swap the insert', 'G4 P2000'])
    expect(marksOf(path)).toBeUndefined()

    const declined = await h.call('slicerx_approve', { request_id: req.request_id, approve: false })
    expect(data<{ status: string }>(declined).status).toBe('denied')
    expect(marksOf(path)).toBeUndefined()

    const again = data<{ request_id: string }>(await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 5, kind: 'custom', gcode }))
    const approved = await h.call('slicerx_approve', { request_id: again.request_id, approve: true })
    expect(approved.isError, text(approved)).toBeFalsy()
    expect(await list()).toEqual([{ z_mm: 5, kind: 'custom', gcode }])
    expect(marksOf(path)).toEqual({ 0: [{ z: 5, kind: 'custom', gcode }] })
  })

  it('asks through the client when it can, and refuses text that changes the printer before asking', async () => {
    const asked: string[] = []
    const { h, path, list } = await harness({}, { elicit: (m) => (asked.push(m), true) })
    const r = await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 3, kind: 'custom', gcode: 'M117 hi' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('M117 hi')
    const bad = await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 4, kind: 'custom', gcode: 'M500' })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('printer memory')
    expect(asked).toHaveLength(1)
    expect(await list()).toEqual([{ z_mm: 3, kind: 'custom', gcode: 'M117 hi' }])
  })

  it('a pause needs no approval under the default policy, and nothing is written when slicing is off', async () => {
    const off = await harness({ policy: { classes: { ...DEFAULT_POLICY.classes, slice: 'off' } } })
    const r = await off.h.call('slicerx_project_layer_mark_add', { project: off.path, z_mm: 4, kind: 'pause' })
    expect(r.isError).toBe(true)
    expect(data<{ status: string }>(r).status).toBe('off')
    expect(marksOf(off.path)).toBeUndefined()
    // listing is a read, so it still answers
    expect(await off.list()).toEqual([])
  })

  it('refuses a plate the project lacks, a height with no mark and a file that is not a 3MF project', async () => {
    const { h, path } = await harness()
    const plate = await h.call('slicerx_project_layer_mark_add', { project: path, plate: 2, z_mm: 4, kind: 'pause' })
    expect(data<{ error: { code: string } }>(plate).error.code).toBe('no_such_plate')
    const none = await h.call('slicerx_project_layer_mark_remove', { project: path, z_mm: 4 })
    expect(data<{ error: { code: string; message: string } }>(none).error).toMatchObject({ code: 'not_found', message: 'Plate 1 has no mark at 4 mm; it has no marks.' })
    const stl = await h.call('slicerx_project_layer_marks', { project: join(h.dir, 'cube.stl') })
    expect(stl.isError).toBe(true)
  })

  it.skipIf(noSx())('slices the pause it saved', { timeout: sxTimeout }, async () => {
    const { h, path } = await harness({ engine: 'sx', sxBin })
    await h.call('slicerx_project_layer_mark_add', { project: path, z_mm: 4, kind: 'pause' })
    const r = await h.call('slicerx_slice_file', { model: path, profiles: ['filament:pla'], overrides: { layer_height: 0.2, skirt_loops: 0 } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8').match(/M601/g)).toHaveLength(1)
  })
})
