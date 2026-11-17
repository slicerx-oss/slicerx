// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project painted in filaments its parts do not print with slices with every filament the paint uses, as the app's
// project open does (packages/app/test/paint-states-open.test.ts): a column on filament 2 painted in filaments 1 to 3
// slices with three filaments, each with its color, not with the two its part names. packages/app/test/
// project-route-parity.test.ts slices it with sx and checks which filament prints each band.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile, withPaintSlots } from '../src/projectfile'
import { BAND_COLORS, bandedProject } from './banded-project'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const dir = mkdtempSync(join(tmpdir(), 'project-paint-filaments-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('a painted project on the printer it names', () => {
  it('opens with the filaments its paint prints in', async () => {
    const path = join(dir, 'banded.3mf')
    writeFileSync(path, bandedProject())
    // The read leaves the geometry alone, and its paint counts once the project opens on a printer.
    expect(readProjectFile(path).opened?.slots).toBe(2)
    const read = withPaintSlots(readProjectFile(path), path)
    expect(read.opened?.slots).toBe(3)
    expect(read.opened?.used).toEqual([1, 2, 3])
    await profiles.prepare(['machine:bambu-a1'])
    const opened = await openProject(read, profiles, ['machine:bambu-a1'], undefined)
    expect(opened?.config['filament_colour']).toEqual(BAND_COLORS.slice(0, 3).map((c) => c.toLowerCase()))
    expect((opened?.config['flush_volumes_matrix'] as unknown[]).length % 9).toBe(0)
  })
})
