// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where exact designs open (design.ts exactOpen and exactKernel): on a served sx-geom with the exact kernel and
// SLICERX_EXACT=1, without the developer opt-in, holding bodies by number; not on one process per call without
// SX_BREP_DEV=1, not on an sx-geom with no exact kernel, and not unless asked. A server given no exactByDefault makes
// mesh designs today, and `exact: true` wins over a false default. Against the stand-in sx-geom (served-engine.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'
import { standInBin } from './served-engine'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'sx-exact-gate-'))
  dirs.push(dir)
  const log = join(dir, 'calls.jsonl')
  vi.stubEnv('SX_STANDIN_LOG', log)
  vi.stubEnv('SX_BREP_DEV', '')
  const read = (): { op?: string; asText?: boolean }[] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { bin: standInBin(dir), read }
}

type Made = { output: { design: string; exact: boolean } }

describe.skipIf(process.platform === 'win32')('exact designs on the MCP server', () => {
  it('opens on a served kernel with SLICERX_EXACT=1, without the developer opt-in, and sends bodies by number only', async () => {
    const { bin, read } = setUp()
    vi.stubEnv('SLICERX_EXACT', '1')
    const h = await connect({ sxGeomBin: bin })
    const made = await h.call('slicerx_design_new', { name: 'Exact', exact: true })
    expect(made.isError, text(made)).toBeFalsy()
    const d = data<Made>(made).output
    expect(d.exact).toBe(true)
    const step = await h.call('slicerx_geom_extrude', { design: d.design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 5 })
    expect(step.isError, text(step)).toBeFalsy()
    expect(read().filter((l) => l.op?.startsWith('brep.extrude'))).not.toEqual([])
    expect(read().filter((l) => l.op && l.asText)).toEqual([])
  }, 30_000)

  it('stays off on a served kernel unless SLICERX_EXACT=1 or the developer opt-in is set', async () => {
    const { bin } = setUp()
    vi.stubEnv('SLICERX_EXACT', '')
    const h = await connect({ sxGeomBin: bin })
    const refused = await h.call('slicerx_design_new', { name: 'Exact', exact: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('Exact designs are off: set SLICERX_EXACT=1 to turn them on, or the developer opt-in SX_BREP_DEV=1.')
  }, 30_000)

  it('needs the developer opt-in on one process per call, which sends bodies as text, SLICERX_EXACT=1 or not', async () => {
    setUp()
    vi.stubEnv('SLICERX_EXACT', '1')
    const calls: string[] = []
    const h = await connect({ geomEngine: async (op) => { calls.push(op); return { bodies: 0 } } })
    const refused = await h.call('slicerx_design_new', { name: 'Exact', exact: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('This sx-geom runs once per call, with no serve mode, so exact designs here need the developer opt-in SX_BREP_DEV=1.')
    expect(calls).toEqual([])
  })

  it('refuses on a served sx-geom with no exact kernel, saying what it answered', async () => {
    setUp()
    vi.stubEnv('SLICERX_EXACT', '1')
    const engine = Object.assign(async (op: string) => {
      if (op === 'brep.count') throw new Error('op: brep.count is not in this build; it leaves out brep')
      throw new Error(`unexpected ${op}`)
    }, { keepsBodies: async () => true })
    const h = await connect({ geomEngine: engine })
    const refused = await h.call('slicerx_design_new', { name: 'Exact', exact: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('This sx-geom has no exact kernel: op: brep.count is not in this build; it leaves out brep')
    const listed = data<{ output: { designs: unknown[] } }>(await h.call('slicerx_design_list')).output
    expect(listed.designs).toEqual([])
  })

  it('makes a mesh design when not asked, on a server given no exactByDefault, even where exact designs are open', async () => {
    const { bin } = setUp()
    vi.stubEnv('SLICERX_EXACT', '1')
    const h = await connect({ sxGeomBin: bin, exactByDefault: undefined })
    const made = await h.call('slicerx_design_new', { name: 'Plain' })
    expect(made.isError, text(made)).toBeFalsy()
    expect(data<Made>(made).output.exact).toBe(false)
  }, 30_000)

  it('takes exact: true over a false default, and exact: false over a true one', async () => {
    const { bin } = setUp()
    vi.stubEnv('SLICERX_EXACT', '1')
    const off = await connect({ sxGeomBin: bin, exactByDefault: false })
    expect(data<Made>(await off.call('slicerx_design_new', { name: 'Asked', exact: true })).output.exact).toBe(true)
    expect(data<Made>(await off.call('slicerx_design_new', { name: 'Not asked' })).output.exact).toBe(false)
    const on = await connect({ sxGeomBin: bin, exactByDefault: true })
    expect(data<Made>(await on.call('slicerx_design_new', { name: 'Not asked' })).output.exact).toBe(true)
    expect(data<Made>(await on.call('slicerx_design_new', { name: 'Mesh', exact: false })).output.exact).toBe(false)
  }, 30_000)
})
