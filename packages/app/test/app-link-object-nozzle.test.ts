// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// project.object_nozzle over the app link, as the MCP server sends it with --app: print an object with another nozzle
// on a printer whose nozzles differ in size, read the object's nozzle and the plate's map back, and refuse what is
// locked, unknown or would split a shared filament without saying how.
import type { MeshHandle } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setProfileLayer } from '../src/adapters/config'
import { LinkError, runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'

const H2D = { printer_model: 'Bambu Lab H2D', nozzle_diameter: [0.4, 0.6], master_extruder_id: 2, single_extruder_multi_material: true }

function entry(id: string, name: string, slot: number, extra: Partial<PlateEntry> = {}): PlateEntry {
  const parts = [{ name: 'p', slot }]
  const handle = { id, hash: id, name, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts } as unknown as MeshHandle
  return { id, name, handle, parts: parts.map((p) => ({ ...p, positions: new Float32Array(), indices: new Uint32Array() })), colors: ['#bd93f9'], transform: [], ...extra } as unknown as PlateEntry
}

type Out = { summary: string; output: { object: string; nozzle: number; filament: number; added?: number; filamentMap?: { mode: string; map: number[] }; objects: { id: string; nozzle?: number | null; nozzleMm?: number }[] } }
const failure = async (p: Promise<unknown>) => (await p.catch((x: unknown) => x)) as LinkError

beforeEach(() => {
  history().clear()
  setProfileLayer(H2D, [])
  set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', slice: { status: 'idle' }, objectSettings: {}, overrides: {}, toast: null, slotSetup: { 1: { type: 'PLA', brand: '', color: '#ff6a13' } }, plate: [entry('obj_1', 'Left box', 1), entry('obj_2', 'Right box', 1)] })
})
afterEach(() => setProfileLayer(null, []))

describe('project.object_nozzle over the app link', () => {
  it('refuses a shared filament until the call says how, then splits it and reads back', async () => {
    const shared = await failure(runCall('project.object_nozzle', { object: 'Right box', nozzle: 1 }, { id: 'c1', name: 'Print Helper' }))
    expect(shared.code).toBe('invalid_input')
    expect(shared.message).toMatch(/also prints Left box.*new_filament: true/)
    const out = (await runCall('project.object_nozzle', { object: 'Right box', nozzle: 1, new_filament: true }, { id: 'c1', name: 'Print Helper' })) as Out
    expect(out.summary).toBe('Right box prints with Left nozzle, 0.4 mm (filament 2)')
    expect(out.output).toMatchObject({ object: 'obj_2', nozzle: 1, filament: 2, added: 2, filamentMap: { mode: 'manual', map: [2, 1] } })
    expect(out.output.objects).toEqual([
      { id: 'obj_1', name: 'Left box', nozzle: 2, nozzleMm: 0.6 },
      { id: 'obj_2', name: 'Right box', nozzle: 1, nozzleMm: 0.4 },
    ])
    expect(get().toast?.text).toBe('Print Helper set Right box to the left nozzle, 0.4 mm.')
  })

  it('refuses to move a filament a painted object also uses, naming it and the flag to send', async () => {
    // Left box is filament 1 with a face painted filament 2: moving filament 1 alone splits its paint across nozzles.
    set({ slotSetup: { 1: { type: 'PLA', brand: '', color: '#ff6a13' }, 2: { type: 'PLA', brand: '', color: '#0a2989' } }, plate: [entry('obj_1', 'Left box', 1, { paint: { 0: { color: { 0: '8' } } } }), entry('obj_2', 'Right box', 1)] })
    const refused = await failure(runCall('project.object_nozzle', { object: 'Right box', nozzle: 1, move_filament: true }, { id: 'c1', name: 'Print Helper' }))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toBe('Moving filament 1 to nozzle 1 puts the paint of Left box on another nozzle than its other filaments. Send confirm_painted: true with move_filament to move it anyway, or new_filament: true to give Right box a filament of its own.')
    expect(refused.details).toEqual({ painted: ['Left box'] })
    expect(get().plates[0]!.settings.nozzleMap).toBeUndefined()
  })

  it('moves a filament a painted object uses when the call confirms, and reads the split back', async () => {
    set({ slotSetup: { 1: { type: 'PLA', brand: '', color: '#ff6a13' }, 2: { type: 'PLA', brand: '', color: '#0a2989' } }, plate: [entry('obj_1', 'Left box', 1, { paint: { 0: { color: { 0: '8' } } } }), entry('obj_2', 'Right box', 1)] })
    const out = (await runCall('project.object_nozzle', { object: 'Right box', nozzle: 1, move_filament: true, confirm_painted: true }, { id: 'c1', name: 'Print Helper' })) as Out & { output: { paintSplit?: string[] } }
    expect(out.output.paintSplit).toEqual(['Left box'])
    expect(out.output.filamentMap).toEqual({ mode: 'manual', map: [1, 2] })
    expect(out.output.objects).toEqual([
      { id: 'obj_1', name: 'Left box', nozzle: null, conflict: expect.stringMatching(/^Left box prints on nozzles of two sizes \(0\.4 mm and 0\.6 mm\)/) },
      { id: 'obj_2', name: 'Right box', nozzle: 1, nozzleMm: 0.4 },
    ])
  })

  it('refuses what is locked, unknown, a nozzle the printer lacks and arguments of the wrong kind', async () => {
    set({ plate: [entry('obj_1', 'Left box', 1, { locked: true }), entry('obj_2', 'Right box', 1)] })
    expect((await failure(runCall('project.object_nozzle', { object: 'Left box', nozzle: 1 }))).code).toBe('refused')
    expect((await failure(runCall('project.object_nozzle', { object: 'Nothing', nozzle: 1 }))).code).toBe('not_found')
    expect((await failure(runCall('project.object_nozzle', { object: 'Right box', nozzle: 3 }))).message).toMatch(/nozzles 1 to 2/)
    expect((await failure(runCall('project.object_nozzle', { object: 'Right box', nozzle: 1, new_filament: 'yes' }))).code).toBe('invalid_input')
  })

  it('says the sizes are one when they are', async () => {
    setProfileLayer({ ...H2D, nozzle_diameter: [0.4, 0.4] }, [])
    expect((await failure(runCall('project.object_nozzle', { object: 'Right box', nozzle: 1 }))).code).toBe('refused')
  })
})
