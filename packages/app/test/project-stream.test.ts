// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Project meshes are written as XML in pieces and deflated as they are made, so a mesh of millions of triangles never
// becomes one string. The pieces must add up to the same file the whole-string writer made.
import { describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { unzipEntries } from '../src/export/import3mf'
import { projectFiles, writeProjectCompressed } from '../src/export/threemf'
import { TextChunks, crc32, zip, zipCompressed } from '../src/export/zip'
import { compose } from '../src/plate/transform'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 0, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

/** A strip of `n` triangles. */
function strip(n: number): MeshPart {
  const positions = new Float32Array((n + 2) * 3)
  for (let i = 0; i < n + 2; i++) positions.set([(i >> 1) * 0.5, i & 1 ? 1.25 : 0, (i % 7) * 0.1], 3 * i)
  const indices = new Uint32Array(n * 3)
  for (let t = 0; t < n; t++) indices.set(t & 1 ? [t + 1, t, t + 2] : [t, t + 1, t + 2], 3 * t)
  return { name: 'Strip', slot: 1, positions, indices }
}

function plates(n: number): PlateMeta[] {
  const obj: PlateEntry = {
    id: 'a',
    name: 'Strip',
    handle: handle('a'),
    parts: [strip(n)],
    colors: ['#bd93f9'],
    transform: compose({ position: [100, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    paint: { 0: { color: { 3: '4', 10: '8' } } },
  }
  return [{ id: 'p1', name: 'Plate 1', objects: [obj], settings: {} }]
}

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

describe('mesh XML in pieces', () => {
  it('keeps each piece small for a big mesh', () => {
    const files = projectFiles({ plates: plates(30000), bed, settings: {} })
    const model = files.find((f) => f.name === '3D/3dmodel.model')!.data
    expect(model).toBeInstanceOf(TextChunks)
    const pieces = [...(model as TextChunks).chunks()]
    expect(pieces.length).toBeGreaterThan(5)
    for (const p of pieces) expect(p.length).toBeLessThan(400_000)
    const whole = pieces.join('')
    expect(whole).toContain('<triangle v1="4" v2="3" v3="5" paint_color="4"/>')
    expect(whole.match(/<triangle /g)?.length).toBe(30000)
    expect(whole.match(/<vertex /g)?.length).toBe(30002)
  })

  it('deflates to the same files the stored writer makes, in one file and split per object', async () => {
    for (const splitAt of [Infinity, 1]) {
      const input = { plates: plates(9000), bed, settings: { layer_height: '0.2' } }
      const packed = await unzipEntries(await zipCompressed(projectFiles(input, splitAt)))
      const plain = await unzipEntries(zip(projectFiles(input, splitAt)))
      expect([...packed.keys()].sort()).toEqual([...plain.keys()].sort())
      for (const [name, bytes] of plain) expect(text(packed.get(name)) === text(bytes)).toBe(true)
      if (splitAt === 1) expect([...packed.keys()].some((n) => n.startsWith('3D/Objects/'))).toBe(true)
    }
  })

  it('writes the CRC and size of the text, not of the deflated bytes', async () => {
    const t = new TextChunks(() => ['<a>', 'x'.repeat(5000), '</a>'])
    const bytes = await zipCompressed([{ name: 'a.xml', data: t }])
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    const raw = new TextEncoder().encode(String(t))
    expect(view.getUint16(8, true)).toBe(8)
    expect(view.getUint32(14, true)).toBe(crc32(raw))
    expect(view.getUint32(22, true)).toBe(raw.length)
    expect(text((await unzipEntries(bytes)).get('a.xml'))).toBe(String(t))
  })

  it('runs a CRC over pieces the same as over the whole', () => {
    const a = new TextEncoder().encode('hello, ')
    const b = new TextEncoder().encode('world')
    expect(crc32(b, crc32(a))).toBe(crc32(new TextEncoder().encode('hello, world')))
  })

  it('a saved project opens back with the same mesh', async () => {
    const pl = plates(5000)
    const bytes = await writeProjectCompressed({ plates: pl, bed, settings: {} })
    const files = await unzipEntries(bytes)
    const model = text(files.get('3D/3dmodel.model'))
    expect(model.match(/<triangle /g)?.length).toBe(5000)
  })
})
