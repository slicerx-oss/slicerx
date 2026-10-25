// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_list_setting_defaults, driven the way a client drives it: every key's default and scope, equal to the
// defaults.json the integrator kit ships and to slicerx_explain_setting, with the section and keys filters.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, data, text, type Harness } from './helpers'

type Entry = { key: string; scope: 'process' | 'printer' | 'filament'; default: unknown }
type Result = { total: number; settings: Entry[]; no_default: string[] }

const file = JSON.parse(readFileSync(join(__dirname, '..', '..', 'settings', 'defaults.json'), 'utf8')) as Record<string, [string, unknown]>

describe('slicerx_list_setting_defaults', () => {
  let h: Harness
  beforeAll(async () => { h = await connect() })
  afterAll(async () => { await h.client.close() })
  const list = async (args: Record<string, unknown> = {}): Promise<Result> => {
    const r = await h.call('slicerx_list_setting_defaults', args)
    expect(r.isError, text(r)).toBeFalsy()
    return data<Result>(r)
  }

  it('is a read tool in the settings set and says which defaults the engine slices with', async () => {
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_list_setting_defaults')
    expect(tool).toBeDefined()
    expect(tool!.annotations?.readOnlyHint).toBe(true)
    expect(tool!.description).toMatch(/only process defaults/i)
    expect(tool!.description).toMatch(/printer and filament defaults/i)
    expect(tool!.description).toMatch(/override/i)
  })

  it('returns every key of defaults.json with its default and scope', async () => {
    const all = await list()
    const got = Object.fromEntries(all.settings.map((e) => [e.key, [e.scope, e.default]]))
    expect(got).toEqual(file)
    expect(all.total).toBe(Object.keys(file).length)
    expect(all.settings.map((e) => e.key)).toEqual(Object.keys(file))
  })

  it('gives each entry the scope and default slicerx_explain_setting gives', async () => {
    const all = await list()
    for (const e of all.settings) {
      const x = data<{ section: string; default?: unknown }>(await h.call('slicerx_explain_setting', { key: e.key }))
      expect(e.scope, e.key).toBe(x.section)
      expect(e.default, e.key).toEqual(x.default)
    }
  })

  it('names the keys that have no default, left out of the list as in defaults.json', async () => {
    const all = await list()
    expect(all.no_default).toContain('chamber_cooling_mode')
    expect(all.settings.some((e) => e.key === 'chamber_cooling_mode')).toBe(false)
  })

  it('filters by section', async () => {
    for (const section of ['process', 'printer', 'filament'] as const) {
      const r = await list({ section })
      const want = Object.entries(file).filter(([, [s]]) => s === section)
      expect(r.settings.length, section).toBe(want.length)
      expect(r.settings.every((e) => e.scope === section), section).toBe(true)
    }
  })

  it('filters by keys, across sections, and with a section', async () => {
    const r = await list({ keys: ['skirt_loops', 'nozzle_diameter', 'skirt_distance'] })
    expect(r.settings).toEqual([
      { key: 'skirt_loops', scope: 'process', default: 1 },
      { key: 'skirt_distance', scope: 'process', default: 2 },
      { key: 'nozzle_diameter', scope: 'printer', default: [0.4] },
    ].sort((a, b) => Object.keys(file).indexOf(a.key) - Object.keys(file).indexOf(b.key)))
    const both = await list({ section: 'printer', keys: ['skirt_loops', 'nozzle_diameter'] })
    expect(both.settings.map((e) => e.key)).toEqual(['nozzle_diameter'])
    const none = await list({ keys: ['chamber_cooling_mode'] })
    expect(none.settings).toEqual([])
    expect(none.no_default).toEqual(['chamber_cooling_mode'])
  })

  it('refuses an unknown key by name, with the closest keys', async () => {
    const r = await h.call('slicerx_list_setting_defaults', { keys: ['skirt_loops', 'skirt_loop'] })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: invalid_settings: Unknown setting "skirt_loop"\./)
    expect(text(r)).toContain('skirt_loops')
    expect(r.structuredContent).toMatchObject({ error: { code: 'invalid_settings' } })
  })
})
