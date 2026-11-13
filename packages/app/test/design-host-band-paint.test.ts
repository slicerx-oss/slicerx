// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's paint tools on the app's design host, with a height band on an exact design: the preview is the
// step's own replay (the host's trial, which writes nothing to the plate), so it names the faces the band paints as
// the MCP server's preview does, and applying it lands the same paint on the plate. The engine is the MCP tests'
// stand-in (bodies as text, a kernel that splits faces along planes).
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearReplayCache, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { bandEngine, type Row } from '../../mcp/test/band-engine'
import { paintTools } from '../../mcp/src/paint'
import { appDesignHost } from '../src/cad/design-host'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'

const loader = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [30, 10, 20], openEdges: 0, parts: [] }) }
const BED = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
const hull: StepParams = { op: 'shape.extrude', frame: BED, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, spec: { distanceMm: 20, operation: 'new' }, name: 'Hull' }

beforeEach(() => {
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, settingsMode: 'developer' })
  localStorage.setItem('sx.exactSolids', '1')
})

afterEach(() => {
  setGeomProvider(null)
  clearReplayCache()
  localStorage.removeItem('sx.exactSolids')
  set({ plate: [], selection: null, selectedIds: [], settingsMode: 'simple' })
})

it('previews a band on an exact design by its faces, writes nothing until it is applied, then lands the same paint', async () => {
  const e = bandEngine()
  setGeomProvider({ call: async <T,>(op: string, request: unknown) => (await e.call(op, request)) as T })
  const host = appDesignHost(loader)
  const d = await host.create('Hull', [], undefined, undefined, { exact: true })
  await host.add(d, 0, hull)
  const tools = paintTools(host)
  const run = (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!
    return t.run(t.input.parse(args) as never, undefined as never) as Promise<{ ok?: boolean; output: Record<string, unknown> }>
  }
  const before = get().plate[0]!
  const preview = await run('paint.preview', { design: d.id, layer: 'color', state: 2, target: { kind: 'height', below: 4 } })
  const rows = preview.output['parts'] as Row[]
  // the bottom (30 x 10) and the side's piece below 4 mm (30 x 4)
  expect(rows[0]!.faces!.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
  // the trial wrote nothing: the plate's object is the one it was
  expect(get().plate[0]).toBe(before)
  expect(get().plate[0]!.history?.steps).toHaveLength(1)

  const applied = await run('paint.apply', { preview: preview.output['preview'] })
  expect(applied.ok).toBe(true)
  expect(get().plate[0]!.history?.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'paint'])
  const faces = (applied.output['paint'] as Row[])[0]!.faces!
  expect(faces.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
})
