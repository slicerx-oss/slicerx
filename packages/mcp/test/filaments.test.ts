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

  it('refuses a filament that is not there, a color or type it cannot read, and a seventeenth', async () => {
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
    for (let i = 2; i <= 16; i++) expect((await h.call('slicerx_project_add_filament', {})).isError).toBeFalsy()
    const full = await h.call('slicerx_project_add_filament', {})
    expect(full.isError).toBe(true)
    expect(text(full)).toMatch(/already has 16 filaments/)
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
    await h.call('slicerx_project_set_filament', { slot: 1, type: 'PETG', color: '#00ff00' })
    await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#ffffff' })
    const sliced = await h.call('slicerx_slice')
    expect(sliced.isError, text(sliced)).toBeFalsy()
  }, sxTimeout)
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
