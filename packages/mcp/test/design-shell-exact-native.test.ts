// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client shells a design that must stay exact, and lofts one thickened, on the real engine with the exact kernel: the
// shell runs on the kernel (brep.shell, never the mesh shell), the part reads back exact, and its volume is the closed
// form of a true constant wall. Skips, saying why, on an engine without the kernel. The tool says which bodies get exact
// walls, in words held here word for word.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { connect, data, noKernel, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
const why = noKernel(bin)
const exact = why === null
const skipped = why ? ` (skipped: ${why})` : ''
afterEach(() => { vi.unstubAllEnvs(); clearReplayCache() })

async function client() {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await h.call(name, args)
    expect(result.isError, text(result)).toBeFalsy()
    return data<{ output: Record<string, unknown> }>(result).output
  }
  return { calls, ok }
}

it.skipIf(!exact)(`shells an exact box open at its top on the kernel, with a true 2 mm wall${skipped}`, async () => {
  const { calls, ok } = await client()
  const d = (await ok('slicerx_design_new', { exact: true })).design as string
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 30 }, placement: { center: [20, 15] }, distance_mm: 20 })
  const shelled = await ok('slicerx_geom_shell', { design: d, open: [{ at: [20, 15, 20], normal: [0, 0, 1] }], wall_mm: 2 })
  expect(calls).toContain('brep.shell')
  expect(calls).not.toContain('shell')
  expect(shelled).toMatchObject({ exact: true, sizeMm: [40, 30, 20] })
  // 40 x 30 x 20 less the 36 x 26 x 18 cavity
  expect(shelled['volumeMm3'] as number).toBeCloseTo(24000 - 36 * 26 * 18, 1)
}, 30000)

it.skipIf(!exact)(`shells an exact cylinder open at its top with a true round wall, where the mesh shell would use voxels${skipped}`, async () => {
  const { calls, ok } = await client()
  const d = (await ok('slicerx_design_new', { exact: true })).design as string
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 20 }, placement: { center: [0, 0] }, distance_mm: 20 })
  const shelled = await ok('slicerx_geom_shell', { design: d, open: [{ at: [0, 0, 20], normal: [0, 0, 1] }], wall_mm: 1.5 })
  expect(calls).toContain('brep.shell')
  expect(calls).not.toContain('shell')
  expect(shelled['exact']).toBe(true)
  // the part reads back as its tessellation, within the 0.01 mm chord of the true walls
  const want = Math.PI * (100 * 20 - 8.5 * 8.5 * 18.5)
  expect(Math.abs((shelled['volumeMm3'] as number) - want) / want).toBeLessThan(2e-3)
}, 30000)

it('says which bodies get exact walls, word for word', async () => {
  // the CAD tools are listed only with an engine; this one is never called
  const h = await connect({ geomEngine: async () => { throw new Error('no engine call to list the tools') } })
  const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_geom_shell')
  expect(tool?.description).toContain('A body whose faces are all flat gets exact walls; on a design with exact solids a curved body does too, unless the exact shell cannot close it, and then it is shelled as a mesh.')
})
