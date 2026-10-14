// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings the app's Expert panel edits as a switch held as a list, a text field or a number-or-percent field, set
// by a client the way it sets any other: over MCP with slicerx_project_set_overrides, and from a shell with
// `slicerx-mcp call`. Each is read back with slicerx_project_show in the form the app stores, a value the setting
// cannot hold is refused with the reason, and the real engine slices with them. Nothing here reaches a printer.
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

/** What a client sends, and what the project then holds: the same values the app's rows store. */
const SENT = { slowdown_for_curled_perimeters: true, solid_infill_rotate_template: '0,90', small_perimeter_speed: '40%', internal_bridge_speed: 30 }
const HELD = { slowdown_for_curled_perimeters: [true], solid_infill_rotate_template: '0,90', small_perimeter_speed: ['40%'], internal_bridge_speed: ['30'] }

type Shown = { output: { overrides: Record<string, unknown> } }

describe('Expert row value types from a client', () => {
  it('are set, read back as the app stores them, and refused when the setting cannot hold them', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { filament: 'pla' })
    const set = await h.call('slicerx_project_set_overrides', { changes: SENT })
    expect(set.isError, text(set)).toBeFalsy()
    expect(data<Shown>(await h.call('slicerx_project_show')).output.overrides).toMatchObject(HELD)
    for (const [key, bad, says] of [['slowdown_for_curled_perimeters', 'maybe', 'expected a bools value'], ['small_perimeter_speed', 'fast', 'expected a floatsOrPercents value'], ['small_perimeter_speed', '-5%', 'outside 1 to inf mm/s']] as const) {
      const r = await h.call('slicerx_project_set_overrides', { changes: { [key]: bad } })
      expect(r.isError, `${key} = ${bad}`).toBe(true)
      expect(text(r)).toContain(says)
    }
    // A refused change leaves the project as it was.
    expect(data<Shown>(await h.call('slicerx_project_show')).output.overrides).toMatchObject(HELD)
  })

  it('are set and read back from a shell', async () => {
    const run = promisify(execFile)
    const h = await connect()
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'off', '--out-dir', join(h.dir, 'out'), '--profiles-dir', join(h.dir, 'profiles'), 'call', 'project_open', '{"filament":"pla"}', 'project_set_overrides', JSON.stringify({ changes: SENT }), 'project_show'],
      { cwd: resolve(__dirname, '..') },
    )
    const last = JSON.parse(stdout.trim().split('\n').at(-1)!) as { tool: string; ok: boolean; output: Shown }
    expect(last).toMatchObject({ tool: 'slicerx_project_show', ok: true })
    expect(last.output.output.overrides).toMatchObject(HELD)
  }, sxTimeout)

  it.skipIf(noSx())('slice in the engine', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.call('slicerx_project_open', { filament: 'pla' })
    expect((await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })).isError).toBeFalsy()
    expect((await h.call('slicerx_project_set_overrides', { changes: SENT })).isError).toBeFalsy()
    const sliced = await h.call('slicerx_slice')
    expect(sliced.isError, text(sliced)).toBeFalsy()
  }, sxTimeout)
})
