// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer project made for another printer opens on the printer the plate is on, and its note offers the printer
// it was made for. Switch to moves the plate there (the person's own printer of that model and nozzle, else our
// profile for it) and works the project's settings out again on that printer; without the button the plate stays.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, PrinterInfo, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../src/adapters/config'
import { projectSettingChanges } from '../src/export/project-settings'
import { readProject } from '../src/export/import3mf'
import { PROJECT_PRINTER_ID, startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const fixtures = join(__dirname, '..', '..')
/** PrusaSlicer 2.9 projects: one for an MK4 on its input shaper firmware (printer_model MK4IS), one for an MK4S. */
const MK4 = join(fixtures, 'core/cli/tests/fixtures/prusa-lift/mk4--isl--FSL30.3mf')
const MK4S = join(fixtures, 'settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')
const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function host(printers: PrinterInfo[] = []): Host {
  return { kind: 'web', capabilities: { threads: 1 }, printers: { list: async () => printers }, slicer: { slice: async () => { throw new Error('stop') }, loadParts: async (name: string) => handle(name) } } as unknown as Host
}

const resolved = (): Record<string, SettingValue> => resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}
/** What of the project's settings the plate does not have now: nothing, once they all apply. */
const missing = async (path: string): Promise<string[]> => Object.keys(projectSettingChanges((await readProject(new Uint8Array(bytes(path)), get().bed)).settings, resolved() as never).values)

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }
const BAY_2: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
const BAY_3: PrinterInfo = { id: 'bay-3', name: 'Bay 3', vendor: 'Prusa Research', model: 'MK4S', plugin: 'prusalink', nozzleCount: 1 }

beforeEach(async () => {
  set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), slotSetup: {}, openNote: null, overrides: {}, vouchedGcode: {}, projectGcode: null, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe('a PrusaSlicer project made for another printer', () => {
  it('stays on the printer the plate is on, and its note offers the one it was made for', async () => {
    await openModelBytes(host(), 'mk4.3mf', bytes(MK4))
    const s = get()
    expect(s.printerId).toBe(A1_MINI.id)
    expect(s.projectPrinter).toBeNull()
    expect(s.profile?.printerId).toBe('bambu-a1-mini')
    expect(s.openNote?.text).toMatch(/^Made for a Prusa Research MK4, 0\.4 mm nozzle\. Applied \d+ settings on the A1 mini\./)
    expect(s.openNote).toMatchObject({ details: 'From mk4.3mf.', wrap: true })
    expect(s.openNote?.action?.label).toBe('Switch to MK4 0.4 mm')
    // Its print and filament values are on the A1 mini already, as before.
    expect(await missing(MK4)).toEqual([])
  })

  it('names the printer by the name the person gave it', async () => {
    set({ printerId: BAY_2.id, printerModel: { id: BAY_2.id, vendor: BAY_2.vendor, model: BAY_2.model } })
    await profileReady()
    await openModelBytes(host([BAY_2]), 'mk4.3mf', bytes(MK4))
    expect(get().openNote?.text).toMatch(/ Applied \d+ settings on Bay 2\./)
    expect(get().printerId).toBe(BAY_2.id)
  })

  it('Switch to moves the plate to our MK4 profile and works the settings out again there', async () => {
    set({ overrides: { wall_loops: 5 } })
    await openModelBytes(host(), 'mk4.3mf', bytes(MK4))
    get().openNote!.action!.run()
    await until(() => get().openNote?.text.startsWith('Switched') === true)
    const s = get()
    expect(s.printerId).toBe(PROJECT_PRINTER_ID)
    expect(s.projectPrinter).toMatchObject({ model: 'MK4', nozzle: 0.4, source: 'mk4.3mf', previousPrinterId: A1_MINI.id })
    expect(s.profile).toMatchObject({ printerId: 'prusa-mk4', nozzle: 0.4 })
    expect(s.openNote?.text).toMatch(/^Switched to MK4 0\.4 mm\. Applied \d+ settings from the project\.$/)
    expect(s.openNote).toMatchObject({ details: 'From mk4.3mf.', wrap: true })
    expect(s.openNote?.action?.label).toBe('Change printer')
    expect(await missing(MK4)).toEqual([])
    // Starting a new project puts back what the person had before the open.
    const { clearProject } = await import('../src/project/new')
    clearProject()
    expect(get().overrides['wall_loops']).toBe(5)
    expect(get().printerId).toBe(A1_MINI.id)
  })

  it('Switch to keeps every setting the person changed after the open, and works out only what came from the project', async () => {
    await openModelBytes(host(), 'mk4.3mf', bytes(MK4))
    const fromProject = get().projectSettings!.keys.find((k) => k in get().overrides && typeof get().overrides[k] === 'number')!
    expect(fromProject).toBeDefined()
    // One of the project's values changed by hand, one setting the project does not touch, and one the project set cleared.
    const cleared = get().projectSettings!.keys.find((k) => k !== fromProject && k in get().overrides)!
    set((s) => {
      const overrides: Record<string, SettingValue> = { ...s.overrides, [fromProject]: (s.overrides[fromProject] as number) + 1, brim_width: 7 }
      delete overrides[cleared]
      return { overrides }
    })
    const mine = { [fromProject]: get().overrides[fromProject], brim_width: 7 }
    get().openNote!.action!.run()
    await until(() => get().openNote?.text.startsWith('Switched') === true)
    expect(get().profile).toMatchObject({ printerId: 'prusa-mk4' })
    expect(get().overrides).toMatchObject(mine)
    expect(get().overrides).not.toHaveProperty(cleared)
    expect(get().openNote?.text).toMatch(/ Kept 3 settings you changed\.$/)
    // Everything else the project sets is on the MK4 now.
    expect((await missing(MK4)).filter((k) => !(k in mine) && k !== cleared)).toEqual([])
  })

  it("Switch to picks the person's own printer of that model and nozzle", async () => {
    await openModelBytes(host([BAY_2, BAY_3]), 'mk4s.3mf', bytes(MK4S))
    expect(get().printerId).toBe(A1_MINI.id)
    expect(get().openNote?.action?.label).toBe('Switch to Bay 3')
    get().openNote!.action!.run()
    await until(() => get().openNote?.text.startsWith('Switched') === true)
    expect(get().printerId).toBe(BAY_3.id)
    expect(get().projectPrinter).toBeNull()
    expect(get().profile).toMatchObject({ printerId: 'prusa-mk4s', nozzle: 0.4 })
    expect(get().openNote?.text).toMatch(/^Switched to Bay 3\. /)
    expect(await missing(MK4S)).toEqual([])
  })

  it('opened on the printer it was made for, offers nothing', async () => {
    set({ printerId: BAY_3.id, printerModel: { id: BAY_3.id, vendor: BAY_3.vendor, model: BAY_3.model } })
    await profileReady()
    await openModelBytes(host([BAY_3]), 'mk4s.3mf', bytes(MK4S))
    expect(get().openNote?.text).toMatch(/^Applied \d+ settings from mk4s\.3mf/)
    expect(get().openNote?.action).toBeUndefined()
  })
})
