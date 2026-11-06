// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arranging the distinct parts of a file's plate on the printer's bed (slicerx_arrange_file, and placement "arrange"
// on slicerx_slice_file and slicerx_estimate_file), with the engine's arrange: clear of the printer's keep-out zones
// (the A1's nozzle wrap check corner), the extruder clearance apart when the plate prints by object, and the parts
// with no room named instead of overlapped.
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serverTools } from '../src/server'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const A1_AREA = ['0x0', '256x0', '256x256', '0x256']

/** A project saved for the A1's bed (its printable area in the project's settings): one `size` mm box per build item, its middle at each `(x, y)`. */
function project(path: string, at: [number, number][], size = 20, height = 10): string {
  const h = size / 2
  const box = [0, height].flatMap((z) => [[-h, -h], [h, -h], [-h, h], [h, h]].map(([x, y]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)).join('')
  const tris = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]].map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  const objects = at.map((_, i) => `<object id="${i + 1}" name="Part_${i + 1}" type="model"><mesh><vertices>${box}</vertices><triangles>${tris}</triangles></mesh></object>`)
  const items = at.map(([x, y], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0"/>`)
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join('')}</resources><build>${items.join('')}</build></model>`
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/project_settings.config', data: JSON.stringify({ printable_area: A1_AREA }) }]))
  return path
}

type Arranged = {
  engine: string
  by_object: boolean
  clearance_mm?: number
  spacing_mm: number
  fits: boolean
  objects: { id: string; name: string; center_mm: [number, number]; turn_deg: number; transform: number[] }[]
  not_fit: { id: string; name: string; reason: string }[]
}

const A1 = ['machine:bambu-a1', 'process:standard']
const BY_OBJECT = { print_sequence: 'by object' }

describe('slicerx_arrange_file', () => {
  it('is a read tool that takes the slice inputs and the arrange options the app has', async () => {
    const h = await connect()
    try {
      const tool = serverTools(h.ctx).find((t) => t.name === 'arrange_file')
      expect(tool, 'arrange_file is registered').toBeDefined()
      expect(tool?.permission).toBe('read')
      const shape = (tool?.input as unknown as { shape: Record<string, unknown> }).shape
      for (const k of ['model', 'plate', 'project_settings', 'profiles', 'overrides', 'spacing_mm', 'rotate', 'step_deg', 'effort', 'keep', 'new_plates']) expect(shape, k).toHaveProperty(k)
      expect(shape).not.toHaveProperty('output')
      expect(shape).not.toHaveProperty('placement')
      for (const k of ['by_object', 'fits', 'objects', 'not_fit', 'spacing_mm', 'clearance_mm', 'plates']) expect(tool?.outputShape, k).toHaveProperty(k)
      const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_arrange_file')
      expect(listed?.annotations?.readOnlyHint).toBe(true)
    } finally {
      await h.client.close()
    }
  })

  it('needs the sx engine', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_arrange_file', { model: join(h.dir, 'cube.stl') })
      expect(r.isError).toBe(true)
      expect(data<{ error: { code: string } }>(r).error.code).toBe('engine_unavailable')
    } finally {
      await h.client.close()
    }
  })
})

describe.skipIf(noSx())('arranging a plate of distinct parts on the A1', { timeout: sxTimeout }, () => {
  it('spaces a by-object plate by the extruder clearance, out of the wrap check corner, and the slice takes it', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      // Two parts 5 mm apart, one in the nozzle wrap check corner (x 226 to 256, y 224 to 256).
      const model = project(join(h.dir, 'two-parts.3mf'), [[215, 210], [240, 240]])
      const before = await h.call('slicerx_slice_file', { model, profiles: A1, overrides: BY_OBJECT })
      expect(before.isError, 'the plate as the file lays it out is refused').toBe(true)

      const r = await h.call('slicerx_arrange_file', { model, profiles: A1, overrides: BY_OBJECT })
      expect(r.isError, text(r)).toBeFalsy()
      const a = data<Arranged>(r)
      expect(a.engine).toBe('sx')
      expect(a.by_object).toBe(true)
      expect(a.fits).toBe(true)
      expect(a.clearance_mm).toBe(73)
      expect(a.not_fit).toEqual([])
      expect(a.objects.map((o) => o.name).sort()).toEqual(['Part_1', 'Part_2'])
      const [p, q] = a.objects
      expect(Math.hypot(p!.center_mm[0] - q!.center_mm[0], p!.center_mm[1] - q!.center_mm[1])).toBeGreaterThanOrEqual(73 + 20)
      for (const o of a.objects) {
        expect(o.transform).toHaveLength(16)
        expect(o.center_mm[0] + 10 <= 226 || o.center_mm[1] + 10 <= 224, `${o.name} is out of the corner`).toBe(true)
      }
      // The same plate arranged again comes out the same.
      expect(data<Arranged>(await h.call('slicerx_arrange_file', { model, profiles: A1, overrides: BY_OBJECT })).objects).toEqual(a.objects)

      for (const tool of ['slicerx_slice_file', 'slicerx_estimate_file']) {
        const s = await h.call(tool, { model, profiles: A1, overrides: BY_OBJECT, placement: 'arrange' })
        expect(s.isError, text(s)).toBeFalsy()
        const out = data<{ collisions?: unknown[]; arranged?: Arranged }>(s)
        expect(out.collisions ?? []).toEqual([])
        expect(out.arranged?.objects).toEqual(a.objects)
      }
    } finally {
      await h.client.close()
    }
  })

  it('keeps the parts asked to stay where they are and packs the others round them, with the app\'s turn step and search', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = project(join(h.dir, 'three-parts.3mf'), [[100, 100], [110, 105], [120, 110]], 30, 8)
      const all = data<Arranged>(await h.call('slicerx_arrange_file', { model, profiles: A1 }))
      expect(all.objects).toHaveLength(3)
      const stay = all.objects[0]!.id
      const r = await h.call('slicerx_arrange_file', { model, profiles: A1, keep: [stay], step_deg: 45, effort: 'quick' })
      expect(r.isError, text(r)).toBeFalsy()
      const a = data<Arranged>(r)
      expect(a.fits).toBe(true)
      // The kept part is not moved, so it is not listed; the other two clear it by the spacing.
      expect(a.objects.map((o) => o.id).sort()).toEqual(all.objects.slice(1).map((o) => o.id).sort())
      for (const o of a.objects) expect(o.turn_deg % 45, `${o.name} turns in 45 degree steps`).toBeCloseTo(0, 6)
      // An id the plate does not have is refused, naming it.
      const bad = await h.call('slicerx_arrange_file', { model, profiles: A1, keep: ['no-such-part'] })
      expect(bad.isError).toBe(true)
      expect(text(bad)).toContain('no-such-part')
    } finally {
      await h.client.close()
    }
  })

  it('names the parts with no room, and a slice with placement arrange refuses them', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const at: [number, number][] = Array.from({ length: 40 }, (_, k) => [30 + (k % 8) * 25, 30 + Math.floor(k / 8) * 25])
      const model = project(join(h.dir, 'crowded.3mf'), at, 40, 4)
      const r = await h.call('slicerx_arrange_file', { model, profiles: A1 })
      expect(r.isError, text(r)).toBeFalsy()
      const a = data<Arranged>(r)
      expect(a.by_object).toBe(false)
      expect(a.fits).toBe(false)
      expect(a.not_fit.length).toBeGreaterThan(0)
      expect(a.objects.length + a.not_fit.length).toBe(40)
      expect(a.not_fit.every((o) => o.reason === 'no_room' && /^Part_\d+$/.test(o.name))).toBe(true)
      expect(text(r)).toContain(a.not_fit[0]!.name)

      // With new_plates the same call lays the parts with no room out on new plates, each part on one plate.
      const more = data<Arranged & { plates?: { objects: { id: string }[] }[] }>(await h.call('slicerx_arrange_file', { model, profiles: A1, new_plates: true }))
      expect(more.objects).toEqual(a.objects)
      expect(more.plates?.length).toBeGreaterThan(0)
      const moved = (more.plates ?? []).flatMap((p) => p.objects.map((o) => o.id)).sort()
      expect(moved).toEqual(a.not_fit.map((o) => o.id).sort())

      const s = await h.call('slicerx_slice_file', { model, profiles: A1, placement: 'arrange' })
      expect(s.isError).toBe(true)
      const err = data<{ error: { code: string; message: string; details?: { reason?: string; not_fit?: string[] } } }>(s).error
      expect(err.code).toBe('invalid_input')
      expect(err.details?.reason).toBe('no_room')
      expect(err.details?.not_fit).toEqual(a.not_fit.map((o) => o.name))
      expect(err.message).not.toMatch(/[\u2013\u2014]/)
    } finally {
      await h.client.close()
    }
  })
})
