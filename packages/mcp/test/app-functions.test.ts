// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The checks and project operations the app runs from its panels (gcode_inspect, risk_report, supports,
// mesh_repair and the rest), driven the way a client drives them: the server over stdio, a tool call,
// then a read-back of the project or the check.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { APP_FUNCTIONS } from '@slicerx/pilot/functions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin, sxTimeout } from './helpers'

const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
const hasGeom = existsSync(geomBin)

/** structuredContent: the tool's output as is (the text content wraps printer and file data as untrusted). */
type Out<T = Record<string, unknown>> = { ok: boolean; summary: string; output: T }

/** One server over stdio, as a client starts it: the real sx when there is one, else the stub engine. */
async function stdioSession(): Promise<{ call<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<Out<T>>; raw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>; client: Client; dir: string; realSx: boolean; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-fn-'))
  writeFileSync(join(dir, 'cube.stl'), boxStl(20, 20, 20))
  // The same box with one triangle left out: a hole of three edges for the repair to close.
  const open = boxStl(20, 20, 20).subarray(0, 84 + 11 * 50)
  open.writeUInt32LE(11, 80)
  writeFileSync(join(dir, 'open-box.stl'), open)
  const realSx = !noSx()
  const engine = realSx ? ['--engine', 'sx', '--sx-bin', sxBin] : ['--engine', 'stub']
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', ...engine, ...(hasGeom ? ['--sx-geom-bin', geomBin] : []), '--allow-dir', dir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), '--printers', 'demo', '--no-urls'],
    cwd: resolve(__dirname, '..'),
    env: { ...(process.env as Record<string, string>), SLICERX_SX_GEOM_BIN: hasGeom ? geomBin : join(dir, 'no-sx-geom') },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'stdio-test', version: '0.0.0' })
  await client.connect(transport)
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult
  return {
    client,
    dir,
    realSx,
    raw,
    call: async <T,>(name: string, args: Record<string, unknown> = {}) => data<Out<T>>(await raw(name, args)),
    close: () => client.close(),
  }
}

describe('the app functions over stdio', () => {
  let s: Awaited<ReturnType<typeof stdioSession>>
  beforeAll(async () => {
    s = await stdioSession()
  }, 60_000)
  afterAll(async () => {
    await s?.close()
  })

  it('lists every function the app runs, under its slicerx_ name', async () => {
    const names = new Set((await s.client.listTools()).tools.map((t) => t.name))
    for (const f of APP_FUNCTIONS) expect(names, f).toContain(`slicerx_${f}`)
  })

  it(
    'checks a sliced plate and reads the project back',
    async () => {
      expect((await s.call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })).ok).toBe(true)
      expect((await s.call('slicerx_project_add_model', { model: join(s.dir, 'cube.stl') })).ok).toBe(true)
      expect((await s.call('slicerx_arrange')).ok).toBe(true)

      // Before slicing, the G-code check says what to run first instead of guessing.
      const early = await s.call('slicerx_gcode_inspect', { plate: 1 })
      expect(early.ok).toBe(false)
      expect(early.summary).toMatch(/not sliced yet/)

      const sliced = await s.call<{ plates: { plate: number; layers: number }[] }>('slicerx_slice')
      expect(sliced.ok).toBe(true)
      const layers = sliced.output.plates[0]?.layers ?? 0
      expect(layers).toBeGreaterThan(0)

      // The checks read the plate slicerx_slice just sliced. The stub engine writes no real G-code, and says so.
      const g = await s.call<{ layers: number; timeS: number }>('slicerx_gcode_inspect', { plate: 1 })
      if (s.realSx) {
        expect(g.ok).toBe(true)
        expect(g.output.layers).toBe(layers)
      } else {
        expect(g.ok).toBe(false)
        expect(g.summary).toMatch(/does not look like G-code/)
      }
      const energy = await s.call<{ kwh: number; lines: { line: string }[] }>('slicerx_energy_estimate')
      expect(energy.ok).toBe(true)
      expect(energy.output.lines.map((l) => l.line)).toEqual(['plate 1'])
      expect(energy.output.kwh).toBeGreaterThan(0)
      const risk = await s.call<{ risks: unknown[]; printer: string }>('slicerx_risk_report')
      expect(risk.ok).toBe(true)
      expect(Array.isArray(risk.output.risks)).toBe(true)

      // A plan that cannot be applied says so, and the project is unchanged.
      const before = await s.call('slicerx_project_show')
      const plan = await s.call<{ applied: boolean; modifiers: unknown[] }>('slicerx_region_modifiers', { goals: ['strong_holes'] })
      expect(plan.ok).toBe(true)
      expect(plan.output.applied).toBe(false)
      expect(plan.output.modifiers.length).toBeGreaterThan(0)
      expect((await s.call('slicerx_project_show')).output).toEqual(before.output)

      const supports = await s.call<{ object: string; changes: Record<string, unknown>; applied: boolean }>('slicerx_supports')
      expect(supports.ok).toBe(true)
      expect(supports.output.object).toBe('obj-1')
      expect(supports.output.changes['enable_support']).toBe(false)

      const fit = await s.call<{ outcome: string }>('slicerx_fit_check', { gapMm: 0.2, feature: 'slide' })
      expect(fit.ok).toBe(true)
      expect(fit.output.outcome).toBe('slides')
    },
    sxTimeout * 2,
  )

  it('reads the printers and spools without touching them', async () => {
    const ams = await s.call<{ assignments: { status: string; slot?: string }[] }>('slicerx_ams_mapping', { printerId: 'bay-1', needs: [{ material: 'PLA' }] })
    expect(ams.ok).toBe(true)
    expect(ams.output.assignments[0]?.status).toBe('match')
    const stock = await s.call<{ stock: { material: string }[] }>('slicerx_spool_inventory')
    expect(stock.ok).toBe(true)
    expect(stock.output.stock.length).toBeGreaterThan(0)
    expect((await s.call('slicerx_fleet_overview')).ok).toBe(true)
    expect((await s.call('slicerx_printer_config_check', { printerId: 'bay-1' })).summary).toBeTruthy()
  })

  it.skipIf(!hasGeom)(
    'repairs and hollows a mesh, and the project and a new slice show the change',
    async () => {
      // An STL's triangles share corners, so a closed one measures watertight.
      const cube = await s.call<{ watertight: boolean; openEdges: number }>('slicerx_mesh_analyze', { objectId: 'obj-1' })
      expect(cube.ok).toBe(true)
      expect(cube.output).toMatchObject({ watertight: true, openEdges: 0 })

      expect((await s.call('slicerx_project_add_model', { model: join(s.dir, 'open-box.stl') })).ok).toBe(true)
      const before = await s.call<{ watertight: boolean; openEdges: number }>('slicerx_mesh_analyze', { objectId: 'obj-2' })
      expect(before.output).toMatchObject({ watertight: false, openEdges: 3 })

      const repaired = await s.call<{ replaced: boolean; after: { watertight: boolean } }>('slicerx_mesh_repair', { objectId: 'obj-2' })
      expect(repaired.ok).toBe(true)
      expect(repaired.output.replaced).toBe(true)
      expect(repaired.output.after.watertight).toBe(true)
      // Read-back: the project's object has the new mesh, and analyzing it again agrees.
      const shown = await s.call<{ objects: { id: string; has_mesh: boolean; triangles: number }[] }>('slicerx_project_show')
      expect(shown.output.objects).toContainEqual(expect.objectContaining({ id: 'obj-2', has_mesh: true, triangles: 12 }))
      expect((await s.call<{ watertight: boolean }>('slicerx_mesh_analyze', { objectId: 'obj-2' })).output.watertight).toBe(true)

      const hollowed = await s.call<{ replaced: boolean; volumeAfterCm3: number }>('slicerx_hollow', { objectId: 'obj-1', wallMm: 2 })
      expect(hollowed.ok).toBe(true)
      expect(hollowed.output.replaced).toBe(true)
      expect(hollowed.output.volumeAfterCm3).toBeLessThan(8)
      const after = await s.call<{ objects: { id: string; has_mesh: boolean; triangles: number }[] }>('slicerx_project_show')
      expect(after.output.objects).toContainEqual(expect.objectContaining({ id: 'obj-1', has_mesh: true }))
      expect(after.output.objects.find((o) => o.id === 'obj-1')?.triangles).toBeGreaterThan(12)
      // The replaced meshes slice: the project used to drop a replacement's mesh, and the plate came out empty.
      const sliced = await s.call<{ plates: { layers: number }[] }>('slicerx_slice')
      expect(sliced.ok).toBe(true)
      expect(sliced.output.plates[0]?.layers ?? 0).toBeGreaterThan(0)
    },
    sxTimeout * 2,
  )
})

describe('the app functions and the permission policy', () => {
  it('refuses a function that changes the project when the policy turns project changes off', async () => {
    const h = await connect({ policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    await h.call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    const r = await h.call('slicerx_supports')
    expect(r.isError).toBe(true)
    // Reading still works.
    expect((await h.call('slicerx_fit_check', { gapMm: 0.2, feature: 'slide' })).isError).toBeFalsy()
  })
})

describe('region_modifiers with apply over stdio', () => {
  let s: Awaited<ReturnType<typeof stdioSession>>
  beforeAll(async () => {
    s = await stdioSession()
  }, 60_000)
  afterAll(async () => {
    await s?.close()
  })

  it(
    'places the ring, the region and the object settings, and the project reads them back',
    async () => {
      expect((await s.call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })).ok).toBe(true)
      expect((await s.call('slicerx_project_add_model', { model: join(s.dir, 'cube.stl') })).ok).toBe(true)
      const bounds = (await s.call<{ objects: { model_bounds: { min: number[]; max: number[] } }[] }>('slicerx_project_show')).output.objects[0]!.model_bounds
      const mid = [0, 1, 2].map((k) => ((bounds.min[k] ?? 0) + (bounds.max[k] ?? 0)) / 2) as [number, number, number]

      type Applied = {
        applied: boolean
        objectSettings: Record<string, unknown>
        volumes: { id: string; role: string; settings: Record<string, unknown> }[]
        readBack: { objectSettings: Record<string, unknown> | null; volumes: { id: string; role: string }[] | null }
      }
      const out = await s.call<Applied>('slicerx_region_modifiers', {
        goals: ['strong_holes', 'overhangs'],
        apply: true,
        holes: [{ center: mid, diameter: 5 }],
        regions: [{ goal: 'overhangs', shape: { sphere: { diameter: 8 } }, center: [mid[0], mid[1], mid[2] + 4] }],
      })
      expect(out.ok).toBe(true)
      expect(out.output.applied).toBe(true)
      expect(out.output.volumes.map((v) => v.role)).toEqual(['modifier', 'modifier'])
      expect(out.output.volumes[0]?.settings['wall_loops']).toBeDefined()
      // The skill's own read-back comes from the MCP project, not from the plan.
      expect(out.output.readBack.volumes?.map((v) => v.id)).toEqual(out.output.volumes.map((v) => v.id))
      expect(Object.keys(out.output.readBack.objectSettings ?? {})).toEqual(Object.keys(out.output.objectSettings))

      const obj = (
        await s.call<{ objects: { settings: Record<string, unknown>; volumes: { id: string; role: string; shape: string; settings?: Record<string, unknown> }[] }[] }>('slicerx_project_show')
      ).output.objects[0]!
      expect(Object.keys(obj.settings).sort()).toEqual(Object.keys(out.output.objectSettings).sort())
      expect(obj.volumes.map((v) => v.id)).toEqual(out.output.volumes.map((v) => v.id))
      expect(obj.volumes[0]?.shape).toMatch(/^cylinder 11 mm across, 20 mm tall, at \[/)
      expect(obj.volumes[1]?.shape).toMatch(/^sphere 8 mm across at \[/)
      expect(obj.volumes[0]?.settings?.['wall_loops']).toBeDefined()

      // The plate still slices with the volumes on it.
      expect((await s.call('slicerx_slice')).ok).toBe(true)
    },
    sxTimeout * 2,
  )
})
