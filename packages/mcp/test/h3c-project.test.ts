// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project saved for the Bambu Lab H3C (fixtures/h3c-tools.3mf: three PLA filaments and a 2.85 mm TPU, the tools
// set by hand to 1, 3, 7 and the TPU tool) slices on the tools it sets: the hand-set tools win over the slicer's
// pick, which fills only the filaments the project leaves unset.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { readZip, writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const kit = resolve(__dirname, 'fixtures/h3c-tools.3mf')

type Hotends = { auto: boolean; filaments: { slot: number; tool: number; hotend: number; tpu_tool: boolean; tpu285: boolean }[] }

/** The kit project with its own settings changed by `edit`, written to `dir`. */
function kitWith(dir: string, edit: (settings: Record<string, unknown>) => void): string {
  const zip = readZip(readFileSync(kit))
  const entries = zip.names().map((name) => ({ name, data: new Uint8Array(zip.read(name)!) as string | Uint8Array }))
  const at = entries.find((e) => e.name === 'Metadata/project_settings.config')!
  const settings = JSON.parse(zip.text(at.name)!) as Record<string, unknown>
  edit(settings)
  at.data = JSON.stringify(settings)
  const out = join(dir, 'h3c-edited.3mf')
  writeFileSync(out, writeZip(entries))
  return out
}

async function opened(path: string) {
  await profiles.prepare(['machine:bambu-h3c'])
  const o = await openProject(readProjectFile(path), profiles, ['machine:bambu-h3c'], undefined)
  expect(o).toBeDefined()
  return o!.config as Record<string, unknown>
}

describe('an H3C project with its own tools', () => {
  it("slices on the project's own tools", async () => {
    const cfg = await opened(kit)
    expect(cfg['filament_map_mode']).toBe('Manual')
    expect(cfg['filament_nozzle_map']).toEqual([0, 2, 6, 7])
  })

  it('lets the slicer pick only the tools the project leaves unset, on hotends no filament has', async () => {
    const h = await connect()
    // Filaments 1 and 2 set by hand (tools 4 and 1); 3 and 4 left to the slicer, the TPU on the TPU tool.
    const cfg = await opened(kitWith(h.dir, (s) => (s['filament_nozzle_map'] = ['3', '0'])))
    expect(cfg['filament_nozzle_map']).toEqual([3, 0, 1, 7])
  })

  it('leaves the pick to the slicer when the project does', async () => {
    const h = await connect()
    const cfg = await opened(kitWith(h.dir, (s) => (s['filament_map_mode'] = 'Auto For Flush')))
    expect(cfg['filament_map_mode']).toBeUndefined()
    expect(cfg['filament_nozzle_map']).toBeUndefined()
  })

  it.skipIf(noSx())('slices each filament on its hand-set tool', { timeout: sxTimeout * 2 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'h3c-tools.3mf')
    copyFileSync(kit, model)
    const r = await h.call('slicerx_slice_file', { model, project_settings: true, project_gcode: 'profile', profiles: ['machine:bambu-h3c'], placement: 'keep' })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ gcode_path: string; hotends?: Hotends; filament_map?: { nozzles: number[]; auto: boolean } }>(r)
    expect(out.filament_map).toMatchObject({ nozzles: [0, 2, 6, 7], auto: false })
    expect(out.hotends?.auto).toBe(false)
    expect(out.hotends?.filaments.map((f) => [f.slot, f.tool, f.tpu_tool])).toEqual([[1, 1, false], [2, 3, false], [3, 7, false], [4, 8, true]])
    const gcode = readFileSync(out.gcode_path, 'utf8')
    // Each filament change is a T command for that filament, and all four print.
    expect(new Set(gcode.match(/^T\d+$/gm))).toEqual(new Set(['T0', 'T1', 'T2', 'T3']))
  })
})
