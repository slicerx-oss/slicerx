// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// MCP clients edit the app's real table and geometry, then read them independently.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appValueTools } from '../../mcp/src/app-values'
import { connect, data } from '../../mcp/test/helpers'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { refreshBound, setValue } from '../src/cad/value-ops'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-values-replies')
const handle = (name: string): MeshHandle => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 3], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
beforeAll(() => useDesignHost(loader))
beforeEach(() => set({ plate: [], plates: [], activePlate: 'p1', namedValues: [], historyEdit: null, selection: null, selectedIds: [] }))

async function box() {
  const created = await runCall('design.new', { name: 'Bracket' }) as { output: { design: string } }
  const design = created.output.design
  await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
  return design
}

async function client() {
  const h = await connect({ printers: 'off' })
  // Replace only the app-link transport; the MCP schema, permission gate and handlers remain real.
  for (const tool of appValueTools({ call: async <T>(method: string, args = {}) => await runCall(method, args) as T }, 'SlicerX')) {
    Object.assign(h.ctx.tools.find((t) => t.name === tool.name)!, tool)
  }
  return h
}

describe('project values over the app link', () => {
  it('creates expressions, binds a step, updates the solid, unbinds and removes with independent read-back', async () => {
    const design = await box()
    const h = await client()
    try {
      expect((await h.call('slicerx_app_value_set', { name: 'height', expression: '3' })).isError).not.toBe(true)
      await h.call('slicerx_app_value_set', { name: 'lip', expression: 'height * 2' })
      expect(data(await h.call('slicerx_app_step_bind', { design, step: 1, expression: 'lip' }))).toMatchObject({ output: { applied: true, replayed: [design], bindings: [{ value: 6, resolved: 6, state: 'current' }] } })
      await h.call('slicerx_app_value_set', { name: 'height', expression: '5' })
      expect(data(await h.call('slicerx_app_values'))).toMatchObject({ output: { values: [{ name: 'height', value: 5 }, { name: 'lip', value: 10 }], bindings: [{ design, expression: 'lip', value: 10, state: 'current' }] } })
      expect(await runCall('design.steps', { design })).toMatchObject({ output: { sizeMm: [20, 10, 10], volumeMm3: 2000 } })
      const refused = await h.call('slicerx_app_value_remove', { name: 'lip' })
      expect(refused.isError).toBe(true)
      expect(data(refused)).toMatchObject({ error: { code: 'invalid_input' } })
      const step = get().plate[0]!.history!.steps[0]!.id
      await h.call('slicerx_app_step_bind', { design, step, expression: null })
      expect(get().plate[0]!.history!.steps[0]!.bind).toBeUndefined()
      await h.call('slicerx_app_value_remove', { name: 'lip' })
      await h.call('slicerx_app_value_remove', { name: 'height' })
      expect(data(await h.call('slicerx_app_values'))).toMatchObject({ output: { values: [], bindings: [], issues: [] } })
      expect(await runCall('design.steps', { design })).toMatchObject({ output: { sizeMm: [20, 10, 10] } })
    } finally { await h.client.close() }
  })

  it('returns applied state for broken expressions and refuses an invalid bind before changing geometry', async () => {
    const design = await box()
    await runCall('values.set', { name: 'height', expression: '3' })
    await runCall('values.bind', { design, step: 1, expression: 'height' })
    const original = get().plate[0]
    await expect(runCall('values.bind', { design, step: 1, expression: 'missing + 1' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(get().plate[0]).toBe(original)
    const h = await client()
    try {
      const broken = await h.call('slicerx_app_value_set', { name: 'height', expression: 'height / 0' })
      expect(broken.isError).toBe(true)
      expect(data(broken)).toMatchObject({ error: { code: 'invalid_input', details: { applied: true, bindings: [{ value: 3, state: 'broken' }] } } })
      expect(get().namedValues).toEqual([{ name: 'height', expr: 'height / 0' }])
      expect(await runCall('design.steps', { design })).toMatchObject({ output: { sizeMm: [20, 10, 3] } })
      expect((await h.call('slicerx_app_value_set', { name: 'height', expression: '4mm' })).isError).not.toBe(true)
      expect(await runCall('design.steps', { design })).toMatchObject({ output: { sizeMm: [20, 10, 4] } })
    } finally { await h.client.close() }
  })

  it('keeps a binding when renaming a step and clears it when typing a number through the existing edit command', async () => {
    const design = await box()
    await runCall('values.set', { name: 'height', expression: '3' })
    await runCall('values.bind', { design, step: 1, expression: 'height' })
    await runCall('design.edit_step', { design, step: 1, label: 'Bracket depth' })
    expect(get().plate[0]!.history!.steps[0]!.bind).toBe('height')
    await runCall('design.edit_step', { design, step: 1, value: 7 })
    expect(get().plate[0]!.history!.steps[0]!.bind).toBeUndefined()
    await runCall('values.set', { name: 'height', expression: '5' })
    expect(await runCall('values.list', {})).toMatchObject({ bindings: [], issues: [] })
    expect(await runCall('design.steps', { design })).toMatchObject({ output: { sizeMm: [20, 10, 7], volumeMm3: 1400 } })
  })

  it('lists pending bindings on other plates and refuses removal while any plate uses the value', async () => {
    const design = await box()
    await runCall('values.set', { name: 'height', expression: '3' })
    await runCall('values.bind', { design, step: 1, expression: 'height' })
    set({ plates: [{ id: 'p2', name: 'Other', objects: [{ ...get().plate[0]!, id: 'other' }] }] as never })
    expect(await runCall('values.set', { name: 'height', expression: '7' })).toMatchObject({ bindings: [{ design, value: 7, state: 'current' }, { plate: 'p2', design: 'other', value: 3, resolved: 7, state: 'pending' }] })
    await runCall('values.bind', { design, step: 1, expression: null })
    await expect(runCall('values.remove', { name: 'height' })).rejects.toThrow(/used by 1 step/)
    expect(get().plates[0]!.objects[0]!.history!.steps[0]!.bind).toBe('height')
  })

  it('validates names and inputs, exposes built-ins and waits for a person editing history', async () => {
    for (const name of ['nozzle', 'clearance', '1bad', 'with space']) await expect(runCall('values.set', { name, expression: '3' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runCall('values.set', { name: 'wall', expression: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runCall('values.bind', { design: 'missing', step: 0, expression: null })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runCall('values.remove', { name: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
    set({ historyEdit: { objectId: 'editing' } as never })
    await expect(runCall('values.set', { name: 'wall', expression: '2' })).rejects.toMatchObject({ code: 'busy' })
    expect(await runCall('values.list', {})).toMatchObject({ values: [], builtIns: { nozzle: expect.any(Number), clearance: expect.any(Number) } })
  })

  it('serializes overlapping UI and command refreshes without applying the same history twice', async () => {
    const design = await box()
    await runCall('values.set', { name: 'height', expression: '3' })
    await runCall('values.bind', { design, step: 1, expression: 'height' })
    setValue('height', '8')
    const loadParts = vi.fn(loader.loadParts)
    const results = await Promise.all([refreshBound({ loadParts }), refreshBound({ loadParts })])
    expect(results).toEqual([{ replayed: [design], broken: [] }, { replayed: [], broken: [] }])
    expect(loadParts).toHaveBeenCalledTimes(1)
    expect(await runCall('values.list', {})).toMatchObject({ bindings: [{ value: 8, state: 'current' }] })
  })
})
