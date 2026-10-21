// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design saved over MCP is written by the app's 3MF writer (@slicerx/threemf) and reads back through the engine's
// 3MF reader (format.read3mf) as the same object: its name, its parts with their slots, triangles and paint, its
// placement, and its CAD history.
import { IDENTITY, type HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { design3mf, readDesigns, type Design } from '../src/design'
import { readZip } from '../src/zip'
import { useGeomEngine } from './geom-engine'

function box(name: string, slot: number, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): HistoryMesh {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!])
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { name, slot, positions, indices }
}

interface ReadPart {
  name?: string
  kind?: string
  slot?: number | null
  positions?: number[]
  indices?: number[]
  paint?: Record<string, [number, string][]> | null
}

const geom = useGeomEngine('design-3mf-writer')

describe('a design saved over MCP, read back by the engine', () => {
  const base = { ...box('Base', 2, [0, 0, 0], [20.25, 10, 3]), paint: { color: { 0: '8', 1: '8' } } }
  const button = box('Button', 3, [8, 3, 3], [12, 7, 5])
  const moved = [...IDENTITY]
  moved[12] = 100
  moved[13] = 90
  const d: Design = {
    id: 'd1',
    name: 'Cable clip',
    history: { version: 1, base: [base], steps: [{ id: 's1', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [10, 5, 3], normal: [0, 0, 1], distanceMm: 2 } }] },
    transform: moved,
    parts: [base, button],
    status: [],
    madeBy: {},
    written: 0,
    redo: [],
  }

  it('has the same object, parts, slots, paint and placement', async () => {
    const bytes = design3mf(d)
    const read = (await geom.engine('format.read3mf', { data: { base64: bytes.toString('base64') } })) as { unitScale?: number; objects?: { name?: string; transform?: number[]; parts?: ReadPart[] }[] }
    expect(read.objects).toHaveLength(1)
    const o = read.objects![0]!
    expect(o.name).toBe('Cable clip')
    expect(o.transform).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 90, 0])
    expect(o.parts?.map((p) => [p.name, p.kind ?? 'normal', p.slot, p.indices?.length])).toEqual([
      ['Base', 'normal', 2, 36],
      ['Button', 'normal', 3, 36],
    ])
    expect(o.parts![0]!.positions!.map((v) => Math.round(v * 1e4) / 1e4)).toEqual(base.positions)
    expect(o.parts![1]!.positions).toEqual(button.positions)
    expect(o.parts![0]!.paint?.['color']).toEqual([[0, '8'], [1, '8']])
  })

  it('opens again as a design with its steps', async () => {
    const [again, ...more] = await readDesigns(geom.engine, design3mf(d), 'clip.3mf')
    expect(more).toHaveLength(0)
    expect(again?.name).toBe('Cable clip')
    expect(again?.transform).toEqual(moved)
    expect(again?.history?.steps.map((s) => s.params.op)).toEqual(['face.push'])
    expect(again?.history?.base.map((p) => [p.name, p.slot, p.indices.length])).toEqual([['Base', 2, 36]])
    expect(again?.base.map((p) => [p.name, p.slot])).toEqual([['Base', 2], ['Button', 3]])
  })

  it('is laid out as the app writes a project', () => {
    const zip = readZip(design3mf(d))
    expect(zip.names()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/model_settings.config',
      'Metadata/slicerx_history.json',
      'Metadata/slicerx_history/3-0.bin',
    ])
    // Plate 1 holds the object, as Bambu Studio and Orca place it.
    expect(zip.text('Metadata/model_settings.config')).toMatch(/<plate><metadata key="plater_id" value="1"\/>.*<model_instance><metadata key="object_id" value="3"\/>/)
    expect(zip.text('[Content_Types].xml')).toMatch(/Extension="bin" ContentType="application\/octet-stream"/)
    expect(JSON.parse(zip.text('Metadata/slicerx_history.json') ?? '{}')).toMatchObject({ version: 3, bodies: [{ object: '3' }] })
  })
})
