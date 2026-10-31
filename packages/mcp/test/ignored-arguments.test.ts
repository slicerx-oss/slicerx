// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice and estimate tools say which arguments they ignored instead of dropping them without a word: a client that
// passes "printer" or "process" (they are not arguments; profiles is) gets a warning that names them and shows
// profiles, in the text and in the structured warnings and notices. The call still succeeds.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

type Out = { warnings: string[]; notices?: { code: string; message: string }[]; applied: string[] }

const PROFILES_HINT = 'Name the printer, process and filament in profiles instead, by id from slicerx_list_profiles, such as "profiles": ["machine:snapmaker-u1", "process:standard"].'

describe.each(['slicerx_slice_file', 'slicerx_estimate_file'])('%s with arguments it does not take', (tool) => {
  it('warns, naming each ignored argument, and points printer, process, filament and machine to profiles', async () => {
    const h = await connect()
    const r = await h.call(tool, { model: join(h.dir, 'cube.stl'), printer: 'Snapmaker U1', process: 'process:standard', filament: 'PLA', machine: 'U1', speed: 'fast' })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<Out>(r)
    const message = `Ignored arguments this tool does not take: printer, process, filament, machine, speed. ${PROFILES_HINT}`
    expect(out.warnings[0]).toBe(message)
    expect(out.notices?.[0]).toEqual({ code: 'ignored_arguments', message })
    expect(text(r)).toContain(`Warning: ${message}`)
    expect(message).not.toMatch(/[\u2013\u2014]/)
    // The slice itself goes on as without them: no printer was named.
    expect(out.notices?.map((n) => n.code)).toEqual(['ignored_arguments', 'no_printer'])
  })

  it('names other ignored arguments without the profiles hint', async () => {
    const h = await connect()
    const out = data<Out>(await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], layer_height: 0.2 }))
    expect(out.warnings[0]).toBe('Ignored arguments this tool does not take: layer_height.')
    expect(out.notices).toEqual([{ code: 'ignored_arguments', message: 'Ignored arguments this tool does not take: layer_height.' }])
  })

  it('stays quiet when every argument is one it takes', async () => {
    const h = await connect()
    const out = data<Out>(await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1', 'process:standard'] }))
    expect(out.notices).toBeUndefined()
    expect(out.warnings.some((w) => w.startsWith('Ignored arguments'))).toBe(false)
  })
})

describe('slicerx_estimate_file', () => {
  it('ignores output and preview, which only slicerx_slice_file takes', async () => {
    const h = await connect()
    const out = data<Out>(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], output: 'gcode', preview: true }))
    expect(out.warnings[0]).toBe('Ignored arguments this tool does not take: output, preview.')
  })
})
