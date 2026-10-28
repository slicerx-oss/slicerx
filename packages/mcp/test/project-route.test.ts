// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project slice that names a printer opens the project on it the way the app does: the printer's machine, process
// and filament settings under the project's, every setting in the request. Without a printer the project slices with
// its own settings only, as sx slice <project.3mf> does. packages/app/test/project-route-parity.test.ts checks the
// G-code against the app's to the byte.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const prusa = resolve(__dirname, '../../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')
const bambu = resolve(__dirname, '../../geom/tests/corpus/bambu-subtypes.3mf')

describe('a project on a named printer', () => {
  it("puts a PrusaSlicer project's settings over the printer's stock process", async () => {
    const read = readProjectFile(prusa)
    await profiles.prepare(['machine:prusa-mk4'])
    const opened = await openProject(read, profiles, ['machine:prusa-mk4'], undefined)
    expect(opened?.printer).toBe('prusa-mk4')
    // the maker's Standard process reduces infill retractions; the project does not say
    expect(read.config['reduce_infill_retraction']).toBeUndefined()
    expect(opened!.config['reduce_infill_retraction']).toBe(true)
    // a project open leaves variable layer height off, and the project's own values win
    expect(opened!.config['smart_layer']).toBe('off')
    for (const k of ['sparse_infill_density', 'wall_loops']) if (read.config[k] !== undefined) expect(opened!.config[k]).toEqual(read.config[k])
    const r = resolveSliceConfig(store, profiles, ['machine:prusa-mk4'], undefined, { project: { name: 'p.3mf', config: read.config, opened } })
    expect(r.applied).toEqual(['project:p.3mf', 'machine:prusa-mk4'])
    expect(r.explicit['reduce_infill_retraction']).toBe(true)
  })

  it('keeps to the project alone without a printer', async () => {
    const read = readProjectFile(prusa)
    expect(await openProject(read, profiles, [], undefined)).toBeUndefined()
    expect(await openProject(read, profiles, ['process:fine'], undefined)).toBeUndefined()
  })

  it('leaves the G-code of a project made for no known printer to the named one', async () => {
    const read = readProjectFile(bambu)
    await profiles.prepare(['machine:bambu-a1'])
    const opened = await openProject(read, profiles, ['machine:bambu-a1'], undefined)
    expect(opened?.ownGcode).toBe(false)
    const r = resolveSliceConfig(store, profiles, ['machine:bambu-a1'], undefined, { project: { name: 'b.3mf', config: read.config, opened } })
    expect(read.config['machine_start_gcode']).toBeDefined()
    expect(r.explicit['machine_start_gcode']).toBe(opened!.config['machine_start_gcode'])
    expect(r.gcodeKept).toEqual([])
  })
})
