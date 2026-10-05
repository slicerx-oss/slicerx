// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { AutoImport } from '../src/geom/cad'
import { addAutoImport, autoFormatOf, toBase64, useAsMillimeters } from '../src/state/import-auto'
import { bounds, decompose, sizeOf } from '../src/plate/transform'
import { get, set } from '../src/state/store'

const host = { slicer: { loadParts: async (name: string) => ({ id: name, name, parts: [] }) } } as unknown as Host

function cube(side: number, at = 0) {
  const p: number[] = []
  for (const x of [0, side]) for (const y of [0, side]) for (const z of [0, side]) p.push(x + at, y, z)
  return { positions: p, indices: [0, 1, 2, 1, 3, 2] }
}

function result(over: Partial<AutoImport> & { scale?: number; apply?: boolean; bodies?: number } = {}): AutoImport {
  const objects = Array.from({ length: over.bodies ?? 1 }, (_, i) => ({
    name: `body ${i + 1}`,
    parts: [{ name: `body ${i + 1}`, slot: 1, color: null, mesh: cube(1, i * 5), watertight: true }],
    repair: {} as never,
  }))
  return {
    name: 'file',
    format: 'obj',
    objects,
    unit: { unit: over.apply ? 'inch' : 'mm', scale: over.scale ?? 1, confidence: 'high', autoApply: over.apply ?? false, reason: '', sizeBefore: [1, 1, 1], sizeAfter: [25.4, 25.4, 25.4] },
    summary: over.summary ?? [],
    warnings: [],
    slotColors: [],
  } as AutoImport
}

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null }))

describe('automatic import', () => {
  it('knows the formats it routes', () => {
    expect(autoFormatOf('a.STL')).toBe('stl')
    expect(autoFormatOf('b.obj')).toBe('obj')
    expect(autoFormatOf('c.amf')).toBe('amf')
    expect(autoFormatOf('d.3mf')).toBeNull()
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })

  it('scales an inch file to millimeters, drops it to the bed and offers the undo', async () => {
    const ids = await addAutoImport(host, 'bracket.obj', new ArrayBuffer(4), async () => result({ apply: true, scale: 25.4, summary: ['Closed 2 holes.'] }))
    const e = get().plate.find((p) => p.id === ids[0])!
    expect(decompose(e.transform).scale[0]).toBeCloseTo(25.4)
    const b = bounds(e.parts, e.transform)!
    expect(sizeOf(b)[0]).toBeCloseTo(25.4)
    expect(b.min[2]).toBeCloseTo(0)
    const t = get().toast!
    expect(t.text).toMatch(/inches.*25.4 x 25.4 x 25.4 mm.*Closed 2 holes/)
    t.action!.run()
    expect(decompose(get().plate[0]!.transform).scale[0]).toBeCloseTo(1)
  })

  it('splits a multi-body file into objects and keeps millimeters unscaled', async () => {
    const ids = await addAutoImport(host, 'two.amf', new ArrayBuffer(4), async () => result({ bodies: 2 }))
    expect(ids).toHaveLength(2)
    expect(get().plate).toHaveLength(2)
    expect(decompose(get().plate[0]!.transform).scale[0]).toBeCloseTo(1)
    expect(get().toast?.action).toBeUndefined()
  })

  it('refuses a file with nothing in it and a name it does not route', async () => {
    await expect(addAutoImport(host, 'x.obj', new ArrayBuffer(1), async () => ({ ...result(), objects: [] }))).rejects.toThrow(/no geometry/)
    await expect(addAutoImport(host, 'x.txt', new ArrayBuffer(1))).rejects.toThrow(/not an STL/)
    useAsMillimeters(['none'])
  })
})
