// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project object's own layer height (object metadata in Metadata/model_settings.config) beats the smart layer
// heights the default process profile turns on: slicerx_slice_file turns them off for that file and says so. Smart
// layers a client asks for stay, and the slice says which layer heights they replace.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { objectLayerHeights } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

function box(id: number, lo: number[], hi: number[]): string {
  const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
  const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const md = (k: string, v: string) => `<metadata key="${k}" value="${v}"/>`

/** Two 20 mm boxes 12 mm tall, 60 mm apart: "tuned" with `own` as its settings, "plain" with none. */
function project(dir: string, own: Record<string, string>): string {
  const main = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${box(10, [-10, -10, 0], [10, 10, 12])}${box(20, [-10, -10, 0], [10, 10, 12])}</resources><build><item objectid="10" transform="1 0 0 0 1 0 0 0 1 70 100 0"/><item objectid="20" transform="1 0 0 0 1 0 0 0 1 130 100 0"/></build></model>`
  const cfg = `<config><object id="10">${md('name', 'tuned')}${md('extruder', '1')}${Object.entries(own).map(([k, v]) => md(k, v)).join('')}</object><object id="20">${md('name', 'plain')}${md('extruder', '1')}</object><plate>${md('plater_id', '1')}<model_instance>${md('object_id', '10')}</model_instance><model_instance>${md('object_id', '20')}</model_instance></plate></config>`
  const path = join(dir, 'two.3mf')
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }]))
  return path
}

const OFF = 'Smart layer heights are off for this slice: objects in two.3mf set their own layer height (tuned 0.3 mm).'
const KEPT = 'Smart layer heights replace the layer heights objects in two.3mf set for themselves (tuned 0.3 mm).'

describe('the layer heights objects set in a project', () => {
  it('are read by object, on the plate asked for', async () => {
    const h = await connect()
    try {
      const path = project(h.dir, { layer_height: '0.3', wall_loops: '5' })
      expect(objectLayerHeights(path)).toEqual([{ name: 'tuned', layer_height: 0.3 }])
      expect(objectLayerHeights(path, 1)).toEqual([{ name: 'tuned', layer_height: 0.3 }])
      expect(objectLayerHeights(project(h.dir, { wall_loops: '5' }))).toEqual([])
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('slicerx_slice_file with the default smart layers', { timeout: sxTimeout }, () => {
  const slice = async (own: Record<string, string>, overrides: Record<string, unknown>) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: project(h.dir, own), overrides: { print_sequence: 'by object', layer_height: 0.2, initial_layer_print_height: 0.2, ...overrides } })
      expect(r.isError, text(r)).toBeFalsy()
      return { out: data<{ layer_count: number; warnings: string[] }>(r), text: text(r) }
    } finally { await h.client.close() }
  }

  it('slice an object at its own layer height and say smart layers are off', async () => {
    const { out, text: t } = await slice({ layer_height: '0.3' }, {})
    // 12 mm: tuned 0.2 then 0.3 mm layers (40), plain 0.2 mm layers (60), one after the other
    expect(out.layer_count).toBe(100)
    expect(out.warnings).toContain(OFF)
    expect(t).toContain(`Warning: ${OFF}`)
  })

  it('keep smart layers a client asks for, saying which layer heights they replace', async () => {
    const { out } = await slice({ layer_height: '0.3' }, { smart_layer: 'quality' })
    expect(out.layer_count).not.toBe(100)
    expect(out.warnings).toContain(KEPT)
    expect(out.warnings).not.toContain(OFF)
  })

  it('leave smart layers on when no object sets a layer height', async () => {
    const { out } = await slice({ wall_loops: '5' }, {})
    expect(out.warnings.some((w) => w.startsWith('Smart layer heights'))).toBe(false)
  })
})
