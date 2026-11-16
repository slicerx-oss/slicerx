// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client adds filaments to its project and changes their type and color, as a person does on the app's filament
// rail, and reads the result back: over MCP, and from a shell with `slicerx-mcp call`.
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

type Filament = { slot: number; type: string; color: string; source: 'set' | 'profile' }
type Out = { ok: boolean; summary: string; output: { filament?: Filament; project?: { filaments: Filament[] }; filaments?: Filament[] } }

describe('project filaments over MCP', () => {
  it('adds a filament, changes one, and reads both back', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Two colors', printer: 'bambu_p1s', filament: 'pla' })
    // One filament to start: the profile's type and the default color.
    const first = data<Out>(await h.call('slicerx_project_show')).output.filaments!
    expect(first).toEqual([{ slot: 1, type: 'PLA', color: expect.stringMatching(/^#[0-9a-f]{6}$/), source: 'profile' }])

    const added = await h.call('slicerx_project_add_filament', { type: 'petg', color: '#FF5500' })
    expect(added.isError, text(added)).toBeFalsy()
    expect(data<Out>(added).output.filament).toEqual({ slot: 2, type: 'PETG', color: '#ff5500', source: 'set' })

    const changed = await h.call('slicerx_project_set_filament', { slot: 1, color: '#000000' })
    expect(changed.isError, text(changed)).toBeFalsy()

    // Read back with show: what changed, and nothing else.
    const shown = data<Out>(await h.call('slicerx_project_show')).output.filaments!
    expect(shown).toEqual([
      { slot: 1, type: 'PLA', color: '#000000', source: 'set' },
      { slot: 2, type: 'PETG', color: '#ff5500', source: 'set' },
    ])
  })

  it("gives the slice the filaments as the engine's per-filament keys, and nothing until a client sets one", async () => {
    const { McpProject } = await import('../src/project')
    const { ProfileCatalog } = await import('../src/profiles')
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { createNodeSlicerHost } = await import('../src/slicerhost')
    const { createStubSlicer } = await import('../src/slicer')
    const store = new DataStore(resolveDataPaths())
    const project = new McpProject({ name: 'Keys', profiles: [], printer: 'bambu_p1s' }, store, new ProfileCatalog(store), createNodeSlicerHost(createStubSlicer(), '/tmp/slicerx-mcp-test-filaments'))
    const before = project.config(1) as Record<string, unknown>
    project.setFilament(1, { color: '#000000' })
    project.addFilament({ type: 'PETG', color: '#ff5500' })
    const cfg = project.config(1) as Record<string, unknown>
    expect(cfg['filament_type']).toEqual(['PLA', 'PETG'])
    expect(cfg['filament_colour']).toEqual(['#000000', '#ff5500'])
    expect(before['filament_colour']).toBeUndefined()
  })

  it('refuses a filament that is not there, a color or type it cannot read, and a 33rd', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { printer: 'bambu_p1s', filament: 'pla' })
    const missing = await h.call('slicerx_project_set_filament', { slot: 3, color: '#ffffff' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/No filament 3: the project has 1\. Add one with slicerx_project_add_filament\./)
    expect(text(await h.call('slicerx_project_add_filament', { color: 'orange' }))).toMatch(/is not a color/)
    expect(text(await h.call('slicerx_project_add_filament', { type: 'wood' }))).toMatch(/is not a filament type SlicerX knows/)
    expect((await h.call('slicerx_project_set_filament', { slot: 1 })).isError).toBe(true)
    // Nothing refused changed the project.
    expect(data<Out>(await h.call('slicerx_project_show')).output.filaments).toHaveLength(1)
    for (let i = 2; i <= 32; i++) expect((await h.call('slicerx_project_add_filament', {})).isError).toBeFalsy()
    const full = await h.call('slicerx_project_add_filament', {})
    expect(full.isError).toBe(true)
    expect(text(full)).toMatch(/The project already has 32 filaments, the most it holds\./)
    expect((await h.call('slicerx_project_set_filament', { slot: 33, color: '#ffffff' })).isError).toBe(true)
    expect(data<Out>(await h.call('slicerx_project_show')).output.filaments).toHaveLength(32)
  })

  it('sets 32 filaments and reads every one back', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Thirty-two', printer: 'bambu_p1s', filament: 'pla' })
    // 80 or more apart in RGB, so no color is near another the project has
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    const color = (i: number) => `#${hex((i % 4) * 80)}${hex((Math.floor(i / 4) % 4) * 80)}${hex(Math.floor(i / 16) * 120)}`
    for (let i = 2; i <= 32; i++) {
      const r = await h.call('slicerx_project_add_filament', { type: i % 2 ? 'petg' : 'pla', color: color(i) })
      expect(r.isError, text(r)).toBeFalsy()
      expect(data<Out>(r).output.filament?.slot).toBe(i)
    }
    const last = await h.call('slicerx_project_set_filament', { slot: 32, color: '#123456' })
    expect(last.isError, text(last)).toBeFalsy()
    const shown = data<Out>(await h.call('slicerx_project_show')).output.filaments!
    expect(shown).toHaveLength(32)
    expect(shown[16]).toEqual({ slot: 17, type: 'PETG', color: color(17), source: 'set' })
    expect(shown[31]).toEqual({ slot: 32, type: 'PLA', color: '#123456', source: 'set' })
  })

  it('takes filament 32 and no 33rd in the slice and STEP tools', async () => {
    const h = await connect()
    const tools = (await h.client.listTools()).tools
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, { maximum?: number; maxItems?: number; items?: { maxItems?: number; properties?: Record<string, { maximum?: number }> } }>
    const slice = props('slicerx_slice_file')['filaments']!
    expect(slice.maxItems).toBe(32)
    expect(slice.items?.properties?.['slot']?.maximum).toBe(32)
    expect(props('slicerx_project_set_filament')['slot']!.maximum).toBe(32)
    expect(props('slicerx_step_read')['max_filaments']!.maximum).toBe(32)
    expect(props('slicerx_step_read')['filaments']!.maxItems).toBe(32)
  })

  it('needs an open project', async () => {
    const h = await connect()
    const r = await h.call('slicerx_project_add_filament', { color: '#ffffff' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/No project is open/)
  })

  it.skipIf(noSx())('slices with the filaments a client set, on the real engine', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.call('slicerx_project_open', { printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    await h.call('slicerx_project_set_filament', { slot: 1, color: '#00ff00' })
    await h.call('slicerx_project_add_filament', { type: 'PETG', color: '#ffffff' })
    const sliced = await h.call('slicerx_slice')
    expect(sliced.isError, text(sliced)).toBeFalsy()
  }, sxTimeout)
})

describe('project filaments the server keeps, as the mimir tab does', () => {
  /** A project on a printer's spools: PLA white, PLA black, PETG blue and TPU orange, as filaments 1 to 4. */
  async function spools() {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Boat', printer: 'bambu_p1s', filament: 'pla' })
    const steps = [
      await h.call('slicerx_project_set_filament', { slot: 1, color: '#ffffff' }),
      await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#1a1a1f' }),
      await h.call('slicerx_project_add_filament', { type: 'PETG', color: '#3b82f6' }),
      await h.call('slicerx_project_add_filament', { type: 'TPU', color: '#f97316' }),
    ]
    for (const r of steps) expect(r.isError, text(r)).toBeFalsy()
    return h
  }
  const shown = async (h: Awaited<ReturnType<typeof connect>>) => data<Out>(await h.call('slicerx_project_show')).output.filaments!.map((f) => `${f.slot} ${f.type} ${f.color}`)
  const START = ['1 PLA #ffffff', '2 PLA #1a1a1f', '3 PETG #3b82f6', '4 TPU #f97316']

  it('refuses a color the project already has in that material, naming the filament to use, and adds nothing', async () => {
    const h = await spools()
    const near = await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#1C1C1E' })
    expect(near.isError).toBe(true)
    expect(data(near)).toMatchObject({ ok: false, summary: 'Filament 2 is already PLA #1a1a1f, close to #1c1c1e: paint or print with filament 2. Nothing was added.' })
    // with no type, the filament profile's (PLA): an off-white reads as the white the project has
    const white = await h.call('slicerx_project_add_filament', { color: '#f2f2ee' })
    expect(white.isError).toBe(true)
    expect(data(white)).toMatchObject({ ok: false, summary: 'Filament 1 is already PLA #ffffff, close to #f2f2ee: paint or print with filament 1. Nothing was added.' })
    expect(await shown(h)).toEqual(START)
  })

  it("refuses a filament's material change and changes nothing, not even the color asked with it", async () => {
    const h = await spools()
    const petg = await h.call('slicerx_project_set_filament', { slot: 3, type: 'pla', color: '#a8261c' })
    expect(petg.isError).toBe(true)
    expect(data(petg)).toMatchObject({ ok: false, summary: "Filament 3 stays PETG: a filament's material is not changed. For PLA, add a filament with project.add_filament. Nothing changed." })
    expect(await shown(h)).toEqual(START)
  })

  it('still takes a recolor, its own material named again, and a new color or another material', async () => {
    const h = await spools()
    const recolor = await h.call('slicerx_project_set_filament', { slot: 1, type: 'pla', color: '#f2f2ee' })
    expect(recolor.isError, text(recolor)).toBeFalsy()
    expect(text(recolor)).toContain('Filament 1 is PLA #f2f2ee')
    for (const [type, color] of [['PLA', '#a8261c'], ['PLA', '#d9a441'], ['PETG', '#1c1c1e']] as const) {
      const r = await h.call('slicerx_project_add_filament', { type, color })
      expect(r.isError, text(r)).toBeFalsy()
    }
    expect(await shown(h)).toEqual(['1 PLA #f2f2ee', '2 PLA #1a1a1f', '3 PETG #3b82f6', '4 TPU #f97316', '5 PLA #a8261c', '6 PLA #d9a441', '7 PETG #1c1c1e'])
  })

  it('describes the rule in the words the tab tools use', async () => {
    const { ADD_FILAMENT_RULE, SET_FILAMENT_RULE } = await import('../src/filaments')
    const { filamentTools } = await import('../src/toolset')
    const tab = filamentTools({ list: () => [], add: () => undefined, set: () => undefined })
    const h = await connect()
    const tools = (await h.client.listTools()).tools
    const add = tools.find((t) => t.name === 'slicerx_project_add_filament')!
    const set = tools.find((t) => t.name === 'slicerx_project_set_filament')!
    expect(add.description).toContain(ADD_FILAMENT_RULE)
    expect(set.description).toContain(SET_FILAMENT_RULE)
    expect(tab[0]!.description).toContain(ADD_FILAMENT_RULE)
    expect(tab[1]!.description).toContain(SET_FILAMENT_RULE)
  })
})

describe('a near-black beside the black a project has', () => {
  it('is refused over MCP, naming the black filament, and the same color in another material is added', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Boat', printer: 'bambu_p1s', filament: 'pla' })
    for (const r of [await h.call('slicerx_project_set_filament', { slot: 1, color: '#ffffff' }), await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#000000' })]) expect(r.isError, text(r)).toBeFalsy()
    const near = await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#1a1a1a' })
    expect(near.isError).toBe(true)
    expect(data(near)).toMatchObject({ ok: false, summary: 'Filament 2 is already PLA #000000, close to #1a1a1a: paint or print with filament 2. Nothing was added.' })
    // with no type, the filament profile's (PLA): a light gray reads as the white the project has
    expect(data(await h.call('slicerx_project_add_filament', { color: '#e6e6e6' }))).toMatchObject({ ok: false, summary: 'Filament 1 is already PLA #ffffff, close to #e6e6e6: paint or print with filament 1. Nothing was added.' })
    for (const [type, color] of [['PLA', '#333333'], ['PLA', '#d1d3d5'], ['PETG', '#1a1a1a']] as const) {
      const r = await h.call('slicerx_project_add_filament', { type, color })
      expect(r.isError, text(r)).toBeFalsy()
    }
    const shown = data<Out>(await h.call('slicerx_project_show')).output.filaments!.map((f) => `${f.slot} ${f.type} ${f.color}`)
    expect(shown).toEqual(['1 PLA #ffffff', '2 PLA #000000', '3 PLA #333333', '4 PLA #d1d3d5', '5 PETG #1a1a1a'])
  })
})

describe('project filaments from a shell', () => {
  const run = promisify(execFile)
  const cli = (...args: string[]) => run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'off', ...args], { cwd: resolve(__dirname, '..') })
  const lines = (out: string) => out.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string; output: Out | null })

  it('runs the calls in order in one project and prints each result', async () => {
    const { stdout } = await cli('call', 'project_open', '{"printer":"bambu_p1s","filament":"pla"}', 'project_add_filament', '{"type":"PETG","color":"#ff5500"}', 'slicerx_project_set_filament', '{"slot":1,"color":"#000000"}', 'project_show')
    const out = lines(stdout)
    expect(out.map((o) => [o.tool, o.ok])).toEqual([
      ['slicerx_project_open', true],
      ['slicerx_project_add_filament', true],
      ['slicerx_project_set_filament', true],
      ['slicerx_project_show', true],
    ])
    expect(out[3]!.output!.output.filaments).toEqual([
      { slot: 1, type: 'PLA', color: '#000000', source: 'set' },
      { slot: 2, type: 'PETG', color: '#ff5500', source: 'set' },
    ])
  }, 60_000)

  it('stops at the first call that fails, with exit code 1', async () => {
    const failed = await cli('call', 'project_open', '{"printer":"bambu_p1s"}', 'project_set_filament', '{"slot":4,"color":"#ffffff"}', 'project_show').then(
      () => null,
      (e: { code: number; stdout: string }) => e,
    )
    expect(failed?.code).toBe(1)
    const out = lines(failed!.stdout)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ tool: 'slicerx_project_set_filament', ok: false })
    expect(out[1]!.text).toMatch(/No filament 4/)
  }, 60_000)
})
