// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile sync builds a printer's layer once per set of inputs. Opening another slicer's project switches to its
// printer and builds that printer's layer once; the open's later store writes that leave the inputs as they were
// (a copy of the moved Easy controls, the goal going custom on the same tier) build nothing more. Moving an Easy
// control is an input, so it still builds.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'

const builds = vi.hoisted(() => [] as string[])

vi.mock('../src/adapters/profile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/adapters/profile')>()
  return {
    ...real,
    buildProfileLayer: (...args: Parameters<typeof real.buildProfileLayer>) => {
      builds.push(args[0].printer.model)
      return real.buildProfileLayer(...args)
    },
  }
})

const { zip } = await import('../src/export/zip')
const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { get, set } = await import('../src/state/store')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** A one cube Bambu Studio project for a P1S. */
function p1sProject(): ArrayBuffer {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const mesh = `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Cube" type="model">${mesh}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="Cube"/><metadata key="extruder" value="1"/></object></config>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2', filament_colour: ['#000000'] }
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const MK4S = { id: 'mk4s', vendor: 'Prusa Research', model: 'MK4S' }

/** Waits for every build the store writes so far have started, and the ones they start in turn. */
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20))
    await profileReady()
  }
}

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], printerId: MK4S.id, printerModel: MK4S, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', toast: null }))
  startProfileSync()
  await settled()
  builds.length = 0
})

describe('profile builds per open', () => {
  it("builds the project printer's layer once when the open switches printer", async () => {
    await openModelBytes(host, 'cube.3mf', p1sProject(), undefined, { fresh: true })
    await settled()
    expect(get().printerModel?.model).toBe('P1S')
    expect(builds).toEqual(['P1S'])
  })

  it('builds nothing for a store write that leaves the inputs as they were', async () => {
    set((s) => ({ easyTouched: [...s.easyTouched] }))
    set({ goal: 'custom' })
    await settled()
    expect(builds).toEqual([])
  })

  it('builds again when an Easy control is moved', async () => {
    // What the Easy panel writes for a moved control.
    set((s) => ({ easy: { ...s.easy, brim: !s.easy.brim }, goal: 'custom', easyTouched: [...new Set([...s.easyTouched, 'brim'])] }))
    await settled()
    expect(builds).toEqual(['MK4S'])
    // A control moved by a change that does not say which (the store marks it).
    set((s) => ({ easy: { ...s.easy, detail: s.easy.detail === 80 ? 20 : 80 } }))
    await settled()
    expect(get().easyTouched).toContain('detail')
    expect(builds).toEqual(['MK4S', 'MK4S'])
  })
})
