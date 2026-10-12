// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design an MCP client saved (packages/mcp design.ts) opens in the app as one object with its parts, their
// filament slots and its CAD history.
import { IDENTITY, type HistoryMesh } from '@slicerx/cad-history'
import { design3mf, type Design } from '@slicerx/mcp'
import { describe, expect, it } from 'vitest'
import { readProject } from '../src/export/import3mf'

function box(name: string, slot: number, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): HistoryMesh {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!])
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { name, slot, positions, indices }
}

describe('a design saved over MCP', () => {
  it('opens as one object with its parts, slots and history', async () => {
    const base = box('Base', 2, [0, 0, 0], [20, 10, 3])
    const button = box('Button', 3, [8, 3, 3], [12, 7, 5])
    const d: Design = {
      id: 'd1',
      name: 'Cable clip',
      history: { version: 1, base: [base], steps: [{ id: 's1', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [10, 5, 3], normal: [0, 0, 1], distanceMm: 2 } }] },
      transform: [...IDENTITY],
      parts: [base, button],
      status: [],
      madeBy: {},
      written: 0,
      redo: [],
    }
    const bed = { widthMm: 256, depthMm: 256 }
    const p = await readProject(new Uint8Array(design3mf(d)), bed)
    const objects = p.plates.flatMap((pl) => pl.objects)
    expect(objects).toHaveLength(1)
    const o = objects[0]!
    expect(o.name).toBe('Cable clip')
    expect(o.parts.map((x) => [x.name, x.slot, x.indices.length])).toEqual([
      ['Base', 2, 36],
      ['Button', 3, 36],
    ])
    const h = p.histories.get(o.fileId)
    expect(h?.steps.map((s) => s.params.op)).toEqual(['face.push'])
    expect(h?.base[0]?.indices.length).toBe(36)
  })

  it('keeps each part\'s paint per triangle, as Bambu Studio and OrcaSlicer write it', async () => {
    const base = { ...box('Base', 1, [0, 0, 0], [20, 10, 3]), paint: { color: { 0: '8', 1: '8' }, seam: { 4: '4' } } }
    const button = { ...box('Button', 1, [8, 3, 3], [12, 7, 5]), paint: { color: { 2: '0C' } } }
    const d: Design = { id: 'd2', name: 'Painted', history: { version: 1, base: [base, button], steps: [] }, transform: [...IDENTITY], parts: [base, button], status: [], madeBy: {}, written: 0, redo: [] }
    const bytes = design3mf(d)
    const p = await readProject(new Uint8Array(bytes), { widthMm: 256, depthMm: 256 })
    const o = p.plates.flatMap((pl) => pl.objects)[0]!
    expect(o.paint).toEqual({ 0: { color: { 0: '8', 1: '8' }, seam: { 4: '4' } }, 1: { color: { 2: '0C' } } })
  })
})
