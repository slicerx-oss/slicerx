// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An H3C project in the layout Bambu Studio 2.9.1 saves (h3c-variant-projects.ts): the PLA filaments listed with a
// Standard and a High Flow variant, the 2.85 mm TPU with its TPU285 variant only, each filament on a hotend by hand.
// The server reads it, as saved and after the printer's hotends are synced in, picks each filament's values from the
// hotend it is on, and slices it on the hotends the command line's project settings name.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { h3cVariantProject, type H3cLayout } from './h3c-variant-projects'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const LAYOUTS: H3cLayout[] = ['saved', 'synced']

type Hotends = { auto: boolean; filaments: { slot: number; tool: number; hotend: number; tpu_tool: boolean; tpu285: boolean }[] }

function write(dir: string, layout: H3cLayout): string {
  const path = join(dir, `h3c-${layout}.3mf`)
  writeFileSync(path, h3cVariantProject(layout))
  return path
}

describe.each(LAYOUTS)('an H3C project with a TPU285-only filament, %s', (layout) => {
  it("reads each filament's values from the hotend it is on", async () => {
    const h = await connect()
    const c = readProjectFile(write(h.dir, layout)).config
    expect(c['filament_max_volumetric_speed']).toEqual([21, 22, 23, 9])
    expect(c['outer_wall_speed']).toEqual([200])
  })

  it("opens on the printer with the project's types and tools", async () => {
    const h = await connect()
    await profiles.prepare(['machine:bambu-h3c'])
    const o = await openProject(readProjectFile(write(h.dir, layout)), profiles, ['machine:bambu-h3c'], undefined)
    const cfg = o!.config as Record<string, unknown>
    expect(cfg['filament_type']).toEqual(['PLA', 'PLA', 'PLA', 'TPU'])
    expect(cfg['filament_nozzle_map']).toEqual([0, 2, 6, 7])
  })

  it.skipIf(noSx())('slices on the hotends the command line reads from the project', { timeout: sxTimeout * 2 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = write(h.dir, layout)
    // sx project-settings: the project's settings as the engine reads them, the hotends from 0
    const cli = JSON.parse(execFileSync(sxBin, ['project-settings', model], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as Record<string, unknown>
    const hand = (cli['filament_nozzle_map'] as unknown[]).map(Number)
    expect(hand).toEqual([0, 2, 6, 7])
    const r = await h.call('slicerx_slice_file', { model, project_settings: true, project_gcode: 'profile', profiles: ['machine:bambu-h3c'] })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ gcode_path: string; hotends?: Hotends; filament_map?: { nozzles: number[]; auto: boolean } }>(r)
    expect(out.filament_map).toMatchObject({ nozzles: hand, auto: false })
    expect(out.hotends?.filaments.map((f) => f.hotend)).toEqual(hand)
    // the TPU on the TPU285 hotend (tool 8), the PLA on Standard ones
    expect(out.hotends?.filaments.map((f) => [f.slot, f.tool, f.tpu_tool, f.tpu285])).toEqual([[1, 1, false, false], [2, 3, false, false], [3, 7, false, false], [4, 8, true, true]])
    const gcode = readFileSync(out.gcode_path, 'utf8')
    expect(gcode).toMatch(/^; filament_type = PLA;PLA;PLA;TPU$/m)
    expect(new Set(gcode.match(/^T\d+$/gm))).toEqual(new Set(['T0', 'T1', 'T2', 'T3']))
  })
})
