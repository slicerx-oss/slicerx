// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Another slicer's project names the printer it was made for, and a client hears it as a person does in the app's open
// note: slicerx_inspect_project reports the printer and the machine: profile that slices it there, and a slice on
// another printer stays on that printer with a project_printer notice naming the profile to switch to.
import { copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject, projectPrinterUse } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
// A PrusaSlicer 2.9 project for an MK4 on its input shaper firmware (printer_model MK4IS), and one for an MK4S.
const mk4 = resolve(__dirname, '../../core/cli/tests/fixtures/prusa-lift/mk4--isl--FSL30.3mf')
const mk4s = resolve(__dirname, '../../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')

describe('the printer a project was made for', () => {
  it('is read from a PrusaSlicer project, model codes included', () => {
    expect(readProjectFile(mk4).summary.project_printer).toEqual({ name: 'Prusa Research MK4', profile: 'machine:prusa-mk4', nozzle: 0.4 })
    expect(readProjectFile(mk4s).summary.project_printer).toEqual({ name: 'Prusa Research MK4S', profile: 'machine:prusa-mk4s', nozzle: 0.4 })
  })

  it('a slice on that printer uses it, with no notice', async () => {
    const read = readProjectFile(mk4)
    await profiles.prepare(['machine:prusa-mk4'])
    const opened = await openProject(read, profiles, ['machine:prusa-mk4'], undefined)
    expect(projectPrinterUse(read, opened, 'mk4.3mf')).toEqual({ report: { name: 'Prusa Research MK4', profile: 'machine:prusa-mk4', nozzle: 0.4, used: true } })
  })

  it('a slice on another printer stays there, and the notice names the profile that uses the project printer', async () => {
    const read = readProjectFile(mk4)
    await profiles.prepare(['machine:bambu-p1s'])
    const opened = await openProject(read, profiles, ['machine:bambu-p1s'], undefined)
    expect(opened?.printer).toBe('bambu-p1s')
    const use = projectPrinterUse(read, opened, 'mk4.3mf')
    expect(use?.report).toEqual({ name: 'Prusa Research MK4', profile: 'machine:prusa-mk4', nozzle: 0.4, used: false })
    expect(use?.message).toBe("mk4.3mf is set up for a Prusa Research MK4 with a 0.4 mm nozzle; sliced for the Bambu Lab P1S 0.4 mm. Slice with machine:prusa-mk4 to use the project's printer.")
  })

  it('says nothing without a printer named, as the slice keeps to the project alone', async () => {
    const read = readProjectFile(mk4)
    expect(projectPrinterUse(read, await openProject(read, profiles, [], undefined), 'mk4.3mf')).toBeUndefined()
  })
})

describe('through the server', () => {
  it('slicerx_inspect_project reports the printer and the profile to slice it with', async () => {
    const h = await connect()
    const file = join(h.dir, 'mk4.3mf')
    copyFileSync(mk4, file)
    const r = await h.call('slicerx_inspect_project', { file })
    expect(data<{ project_printer?: unknown }>(r).project_printer).toEqual({ name: 'Prusa Research MK4', profile: 'machine:prusa-mk4', nozzle: 0.4 })
    expect(JSON.stringify(r)).toContain('Made for: Prusa Research MK4, 0.4 mm nozzle (slice with machine:prusa-mk4)')
  })

  it.skipIf(noSx())("slicerx_estimate_file on another printer keeps it, and choosing the project's profile uses the project's printer", { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const file = join(h.dir, 'mk4.3mf')
    copyFileSync(mk4, file)
    type Out = { project_printer?: { used?: boolean; profile?: string }; notices?: { code: string; message: string }[] }
    const other = data<Out>(await h.call('slicerx_estimate_file', { model: file, project_settings: true, profiles: ['machine:bambu-p1s'] }))
    expect(other.project_printer).toMatchObject({ profile: 'machine:prusa-mk4', used: false })
    expect(other.notices?.find((n) => n.code === 'project_printer')?.message).toMatch(/Slice with machine:prusa-mk4 to use the project's printer\.$/)
    const own = data<Out>(await h.call('slicerx_estimate_file', { model: file, project_settings: true, profiles: [other.project_printer!.profile!] }))
    expect(own.project_printer).toMatchObject({ profile: 'machine:prusa-mk4', used: true })
    expect(own.notices?.some((n) => n.code === 'project_printer') ?? false).toBe(false)
  })
})
