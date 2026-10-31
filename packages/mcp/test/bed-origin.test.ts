// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Snapmaker U1's printable area runs from 0.5, 1 to 270.5, 271, so its middle is 135.5, 136. A client slicing a
// file on it gets the file where the app and `sx slice` put it: a mesh and a 3MF that is no slicer's project in that
// middle, and a project's build item where the project puts it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bedOf } from '../src/sx'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const U1_AREA = ['0.5x1', '270.5x1', '270.5x271', '0.5x271']

/** A 3MF of 20 x 20 x 10 mm boxes, one build item centered on each `(x, y)`; with `area`, a project on that area. */
function boxes(path: string, at: [number, number][], area?: string[]): string {
  const objects = at.map((_, i) => `<object id="${i + 1}" type="model"><mesh><vertices>${[0, 10].flatMap((z) => [[-10, -10], [10, -10], [-10, 10], [10, 10]].map(([x, y]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)).join('')}</vertices><triangles>${[[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]].map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`)
  const items = at.map(([x, y], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0"/>`)
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join('')}</resources><build>${items.join('')}</build></model>`
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, ...(area ? [{ name: 'Metadata/project_settings.config', data: JSON.stringify({ printable_area: area }) }] : [])]))
  return path
}

/** The `CENTER=` of each object the Klipper G-code defines, in order. */
function centers(gcode: string): [number, number][] {
  return gcode.split('\n').flatMap((l) => {
    const m = /^EXCLUDE_OBJECT_DEFINE .*\bCENTER=(-?[\d.]+),(-?[\d.]+)/.exec(l)
    return m ? [[Number(m[1]), Number(m[2])] as [number, number]] : []
  })
}

describe('the bed a file is sliced on', () => {
  it('is the size of the printable area, also when the area does not start at 0, 0', () => {
    expect(bedOf({ printable_area: U1_AREA, printable_height: 270 })).toEqual({ widthMm: 270, depthMm: 270, heightMm: 270 })
    expect(bedOf({ printable_area: ['0x0', '256x0', '256x256', '0x256'] })).toEqual({ widthMm: 256, depthMm: 256, heightMm: 250 })
    expect(bedOf({ printable_area: ['-150x-150', '150x-150', '150x150', '-150x150'], printable_height: 410 })).toEqual({ widthMm: 300, depthMm: 300, heightMm: 410 })
    expect(bedOf({})).toBeUndefined()
  })
})

// exclude_object on: the G-code then names each object with its center (EXCLUDE_OBJECT_DEFINE).
describe.skipIf(noSx())('a file sliced on the Snapmaker U1', { timeout: sxTimeout }, () => {
  const slice = async (model: (dir: string) => string): Promise<[number, number][]> => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: model(h.dir), profiles: ['machine:snapmaker-u1'], overrides: { exclude_object: true } })
      expect(r.isError, text(r)).toBeFalsy()
      return centers(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'))
    } finally {
      await h.client.close()
    }
  }

  it('puts a mesh in the middle of the printable area', async () => {
    expect(await slice((dir) => join(dir, 'cube.stl'))).toEqual([[135.5, 136]])
  })

  it('puts a 3MF that is no project in the middle, its items as one group', async () => {
    expect(await slice((dir) => boxes(join(dir, 'plain.3mf'), [[135.5, 135.5]]))).toEqual([[135.5, 136]])
    expect(await slice((dir) => boxes(join(dir, 'plain-two.3mf'), [[115.5, 135.5], [155.5, 135.5]]))).toEqual([[115.5, 136], [155.5, 136]])
  })

  it("keeps a project's build items where the project puts them", async () => {
    expect(await slice((dir) => boxes(join(dir, 'project.3mf'), [[135.5, 135.5]], U1_AREA))).toEqual([[135.5, 135.5]])
  })
})

// placement keep: a 3MF's build items where the file puts them, from the corner of the printable area, instead of the
// plate centered; refused as invalid input when a part lands off the area.
describe.skipIf(noSx())('placement on the Snapmaker U1', { timeout: sxTimeout }, () => {
  it.each(['slicerx_slice_file', 'slicerx_estimate_file'])('%s keeps a plain 3MF where the file puts it with placement keep', async (tool) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = boxes(join(h.dir, 'at-80-100.3mf'), [[80, 100]])
      const call = async (placement?: string) => {
        const r = await h.call(tool, { model, profiles: ['machine:snapmaker-u1', 'process:standard'], overrides: { exclude_object: true }, ...(placement ? { placement } : {}) })
        expect(r.isError, text(r)).toBeFalsy()
        return r
      }
      if (tool === 'slicerx_slice_file') {
        const at = async (placement?: string) => centers(readFileSync(data<{ gcode_path: string }>(await call(placement)).gcode_path, 'utf8'))
        expect(await at()).toEqual([[135.5, 136]])
        expect(await at('center')).toEqual([[135.5, 136]])
        expect(await at('keep')).toEqual([[80.5, 101]])
        // A mesh file has no placement of its own: centered under keep too.
        const stl = await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles: ['machine:snapmaker-u1'], overrides: { exclude_object: true }, placement: 'keep' })
        expect(centers(readFileSync(data<{ gcode_path: string }>(stl).gcode_path, 'utf8'))).toEqual([[135.5, 136]])
      } else {
        // Taken, not ignored.
        expect(data<{ notices?: { code: string }[] }>(await call('keep')).notices?.some((n) => n.code === 'ignored_arguments')).toBeFalsy()
      }
    } finally {
      await h.client.close()
    }
  })

  it.each(['slicerx_slice_file', 'slicerx_estimate_file'])('%s refuses a part placement keep puts off the bed, naming it and the overhang', async (tool) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = boxes(join(h.dir, 'off.3mf'), [[265, 100]])
      const r = await h.call(tool, { model, profiles: ['machine:snapmaker-u1', 'process:standard'], placement: 'keep' })
      expect(r.isError).toBe(true)
      const err = data<{ error: { code: string; message: string; details?: Record<string, unknown> } }>(r).error
      expect(err.code).toBe('invalid_input')
      expect(err.details).toEqual({ reason: 'off_bed' })
      expect(err.message).toContain('Object_1 is 5 mm past the right edge of the printable area (X 0.5 to 270.5, Y 1 to 271 mm) where the file places it')
      expect(err.message).not.toMatch(/[\u2013\u2014]/)
      // Centered, the same file slices.
      const centered = await h.call(tool, { model, profiles: ['machine:snapmaker-u1', 'process:standard'] })
      expect(centered.isError, text(centered)).toBeFalsy()
    } finally {
      await h.client.close()
    }
  })
})

describe('placement', () => {
  it('takes only center or keep', async () => {
    const h = await connect()
    const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), placement: 'left' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('placement')
  })
})
