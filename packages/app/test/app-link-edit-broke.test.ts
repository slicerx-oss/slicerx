// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step edit made through an MCP client on the app's design, where the edit leaves a later step not going through:
// the app's design.edit_step answers it as failed, and the MCP server, routing the call to the app, answers it with
// isError and the app's words. The app's real tool over the app link, the MCP server's real routing, schema and gate;
// a stand-in engine, whose cuts stop reaching the part once the box is made thin.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { routeToApp } from '../../mcp/src/app-route'
import { designToolset, NO_ENGINE_HOST } from '../../mcp/src/toolset'
import { connect, data, text } from '../../mcp/test/helpers'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { set } from '../src/state/store'

const tri = { positions: [0, 0, 0, 20, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
// the box's depth as last extruded; a cut on a box thinner than 3 mm stops short of it
let depth = 5

beforeAll(async () => {
  setGeomProvider({
    async call<T>(op: string, request: unknown): Promise<T> {
      const spec = (request as { spec?: { operation?: string; distanceMm?: number } }).spec
      if (op === 'shape.extrude' && spec?.operation !== 'cut' && spec?.distanceMm !== undefined) depth = spec.distanceMm
      if (op === 'shape.extrude' && spec?.operation === 'cut' && depth < 3) return { mesh: tri, removedVolumeMm3: 0, report: { touches: false, miss: { reason: 'apart', gapMm: 2 } } } as T
      return { mesh: tri, removedVolumeMm3: 1, report: { touches: true } } as T
    },
  })
  await useDesignHost({ loadParts: async (name: string, _parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: 1, bboxMm: [20, 10, 5], openEdges: 0, parts: [] }) })
})
afterAll(() => setGeomProvider(null))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

it('answers a step edit the app reports as breaking a later step with isError and the app words', async () => {
  // the server's own engine is never reached: every design call goes to the app (required)
  const h = await connect({ printers: 'off', geomEngine: async (op) => { throw new Error(`the server's own engine was called for ${op}`) } })
  // Only the transport to the app is replaced: the MCP routing, schema, gate and the app's tools are the real ones.
  for (const tool of routeToApp(designToolset(NO_ENGINE_HOST), { call: async <T,>(method: string, args = {}) => (await runCall(method, args)) as T }, 'SlicerX', { required: true })) {
    const mine = h.ctx.tools.find((t) => t.name === tool.name)
    if (mine) Object.assign(mine, tool)
  }
  try {
    const design = (data(await h.call('slicerx_design_new', { name: 'Plate' })) as { output: { design: string } }).output.design
    expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 5 })).isError).toBeFalsy()
    expect((await h.call('slicerx_geom_extrude', { design, part: 0, operation: 'cut', shape: { type: 'circle', diameterMm: 2 }, frame: { origin: [0, 0, 5], normal: [0, 0, -1] }, distance_mm: 2 })).isError).toBeFalsy()
    const passed = await h.call('slicerx_design_edit_step', { design, step: 1, value: 4 })
    expect(passed.isError, text(passed)).toBeFalsy()
    const broke = await h.call('slicerx_design_edit_step', { design, step: 1, value: 1 })
    expect(broke.isError).toBe(true)
    const said = (data(broke) as { summary: string }).summary
    expect(said).toMatch(/^Edited step 1, .*; step 2 broke: .+ \(in SlicerX\)$/)
    // the words are the app's own: its design.edit_step answers the same, as failed, to a client on the link
    const app = (await runCall('design.edit_step', { design, step: 1, value: 1 })) as { ok?: boolean; summary: string }
    expect(app.ok).toBe(false)
    expect(said).toBe(`${app.summary} (in SlicerX)`)
  } finally {
    await h.client.close()
  }
})
