// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it, vi } from 'vitest'
import { geomEngine } from '../src/geom'
import { connect, data, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
afterEach(() => vi.unstubAllEnvs())

it('refuses an exact design before creation when the developer opt-in is off', async () => {
  vi.stubEnv('SX_BREP_DEV', '')
  const calls: string[] = []
  const h = await connect({ geomEngine: async (op) => { calls.push(op); throw new Error('kernel must not run') } })
  const result = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toMatch(/exact.*developer|SX_BREP_DEV/i)
  expect(calls).toEqual([])
  const listed = data<{ output: { designs: unknown[] } }>(await h.call('slicerx_design_list')).output
  expect(listed.designs).toEqual([])
})

it('refuses an unavailable exact kernel without creating a mesh design', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: async () => { throw new Error('exact kernel unavailable') } })
  const result = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(result.isError, text(result)).toBe(true)
  expect(text(result)).toContain('exact kernel unavailable')
  const listed = data<{ output: { designs: unknown[] } }>(await h.call('slicerx_design_list')).output
  expect(listed.designs).toEqual([])
})

it.skipIf(!bin)('selects the real native exact path and reads back its representation', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  const created = await h.call('slicerx_design_new', { name: 'Exact bracket', exact: true })
  expect(created.isError, text(created)).toBeFalsy()
  const d = data<{ output: { design: string; exact: boolean } }>(created).output
  expect(d.exact).toBe(true)
  const extruded = await h.call('slicerx_geom_extrude', { design: d.design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
  expect(extruded.isError, text(extruded)).toBeFalsy()
  expect(calls).toContain('brep.extrude')
  expect(calls).not.toContain('shape.extrude')
  expect(data<{ output: unknown }>(extruded).output).toMatchObject({ exact: true, sizeMm: [30, 10, 3], volumeMm3: 900 })
}, 25000)
