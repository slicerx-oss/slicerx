// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// settings.get reads the host project's settings, trimmed to the keys asked, at most SETTINGS_GET_MAX of them.
import { describe, expect, it } from 'vitest'
import type { PilotProject, PrintSettingsRead } from '../src/project'
import type { ToolContext } from '../src/tool'
import { SETTINGS_GET_DEFAULT, SETTINGS_GET_MAX, settingsReadTool } from '../src/tools/settings'

const VALUES: Record<string, number | string> = { layer_height: 0.2, wall_loops: 2, sparse_infill_density: '15%' }

function project(overrides: Record<string, number> = {}, asked: (readonly string[])[] = []): PilotProject {
  return {
    overrides: () => overrides,
    printSettings(keys: readonly string[]): PrintSettingsRead {
      asked.push(keys)
      if (keys.includes('machine_start_gcode')) throw new Error('machine_start_gcode is not a numeric, switch or choice print setting')
      const pick = (o: Record<string, unknown>) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) as PrintSettingsRead['effective']
      return { plate: 'p1', overrides: pick(overrides), effective: pick({ ...VALUES, ...overrides }), shadowed: [] }
    },
  } as unknown as PilotProject
}

const tool = settingsReadTool()
const run = (input: unknown, p?: PilotProject) => tool.run(tool.input.parse(input) as never, { project: p } as unknown as ToolContext)

describe('settings.get', () => {
  it('reads the keys asked, with their overrides', async () => {
    const res = await run({ keys: ['layer_height'] }, project({ layer_height: 0.28 }))
    expect(res).toMatchObject({ summary: 'layer_height 0.28, 1 overridden', output: { plate: 'p1', overrides: { layer_height: 0.28 }, effective: { layer_height: 0.28 }, shadowed: [] } })
  })

  it('reads the most used settings without keys, and names the overrides it left out', async () => {
    const asked: (readonly string[])[] = []
    const res = await run({}, project({ ironing_spacing: 0.1 }, asked))
    expect(asked).toEqual([SETTINGS_GET_DEFAULT])
    expect(SETTINGS_GET_DEFAULT.length).toBeLessThanOrEqual(SETTINGS_GET_MAX)
    expect(res.output).toMatchObject({ effective: VALUES, otherOverrides: ['ironing_spacing'] })
  })

  it(`takes at most ${SETTINGS_GET_MAX} keys`, () => {
    const keys = Array.from({ length: SETTINGS_GET_MAX + 1 }, (_, i) => `key_${i}`)
    expect(tool.input.safeParse({ keys }).success).toBe(false)
    expect(tool.input.safeParse({ keys: keys.slice(1) }).success).toBe(true)
  })

  it('says why when the host refuses a key or cannot read settings', async () => {
    expect(await run({ keys: ['machine_start_gcode'] }, project())).toMatchObject({ ok: false, summary: expect.stringMatching(/not a numeric/) })
    expect(await run({ keys: ['layer_height'] }, { overrides: () => ({}) } as unknown as PilotProject)).toMatchObject({ ok: false })
    expect(await run({ keys: ['layer_height'] })).toMatchObject({ ok: false })
  })
})
