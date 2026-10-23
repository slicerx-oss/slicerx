// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

type Err = { error: { code: string; message: string } }

describe('error codes', () => {
  it('names the reason in the text and in structured content', async () => {
    const h = await connect()
    const missing = await h.call('slicerx_estimate_file', { model: join(h.dir, 'nope.stl') })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/^Error: file_not_found: /)
    expect(data<Err>(missing).error.code).toBe('file_not_found')
    expect(data<Err>(await h.call('slicerx_estimate_file', { model: process.execPath })).error.code).toBe('path_not_allowed')
    expect(data<Err>(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['printer:nope'] })).error.code).toBe('unknown_profile')
    expect(data<Err>(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), overrides: { not_a_key: 1 } })).error.code).toBe('invalid_settings')
    expect(data<Err>(await h.call('slicerx_get_profile', { profile: 'nope' })).error.code).toBe('unknown_profile')
  })

  it('names preset types for a missing preset file', async () => {
    const h = await connect()
    const gone = join(h.dir, 'gone.json')
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profile_files: [gone] })
    expect(r.isError).toBe(true)
    expect(data<Err>(r).error).toEqual({ code: 'file_not_found', message: `File not found: ${gone}. Pass an absolute path to a .json, .bbscfg, .bbsflmt, .orca_printer, .orca_filament, .orca_bundle or .zip file.` })
  })

  it('gives tools that run through the permission gate the same shape', async () => {
    const h = await connect()
    const r = await h.call('slicerx_sxlock_open', { file: join(h.dir, 'x.sxlock') })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: not_configured: /)
    expect(data<Err>(r).error.code).toBe('not_configured')
  })
})
