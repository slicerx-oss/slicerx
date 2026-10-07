// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave only as .sx3mf: no STL or OBJ export, through the export function, the commands (and so
// the menu and the command bar) or after splitting, cutting or merging; the Vault tag survives a save and a reopen.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { exportMesh, meshExportBytes } from '../src/export/mesh'
import { writeProject } from '../src/export/threemf'
import { fromVault, VAULT_SX3MF_ONLY } from '../src/export/vault'
import { plateCommands } from '../src/plate/commands'
import { mergeSelected, splitSelectedToObjects } from '../src/plate/edit'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const place = (x: number) => compose({ position: [x, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const VAULT = { modelId: '11111111-1111-4111-8111-111111111111', creatorId: '22222222-2222-4222-8222-222222222222' }
const own = (id: string, x = 50): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: place(x) })
const vault = (id: string, x = 120): PlateEntry => ({ ...own(id, x), source: VAULT })
const host = (saved: string[]) => ({ files: { save: async (n: string) => (saved.push(n), { id: n, name: n, size: 1 }) } }) as unknown as Host
const loader = { loadParts: async (name: string) => handle(name) }

beforeEach(() => set({ plate: [own('mine'), vault('vault')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: 'vault', selectedIds: ['vault'], toast: null }))

describe('Vault designs and mesh export', () => {
  it('tells a Vault object from your own', () => {
    expect(fromVault([own('a')])).toBe(false)
    expect(fromVault([own('a'), vault('b')])).toBe(true)
    expect(fromVault([{ source: { creatorId: 'x' } }])).toBe(false)
  })

  it('refuses STL and OBJ for a selected Vault object, and for a plate holding one', async () => {
    const saved: string[] = []
    expect(await exportMesh(host(saved), 'selection', 'stl')).toBe(false)
    expect(get().toast?.text).toBe(VAULT_SX3MF_ONLY)
    expect(await exportMesh(host(saved), 'selection', 'obj')).toBe(false)
    expect(await exportMesh(host(saved), 'plate', 'stl')).toBe(false)
    expect(saved).toEqual([])
    expect(() => meshExportBytes([vault('v')], 'stl')).toThrow(VAULT_SX3MF_ONLY)
  })

  it('still exports your own objects', async () => {
    const saved: string[] = []
    set({ selection: 'mine', selectedIds: ['mine'] })
    expect(await exportMesh(host(saved), 'selection', 'stl')).toBe(true)
    expect(saved).toEqual(['mine.stl'])
  })

  it('turns the export commands off, so the menu and the command bar cannot reach them', () => {
    const cmds = plateCommands(() => 'slicerx' as never, host([]))
    const enabled = (id: string) => cmds.find((c) => c.id === id)?.enabled?.() ?? true
    for (const id of ['export-selection-stl', 'export-selection-obj', 'export-plate-stl', 'export-plate-obj']) expect(enabled(id), id).toBe(false)
    set({ plate: [own('mine')], selection: 'mine', selectedIds: ['mine'] })
    for (const id of ['export-selection-stl', 'export-selection-obj', 'export-plate-stl', 'export-plate-obj']) expect(enabled(id), id).toBe(true)
  })

  it('keeps the Vault tag through split and merge', async () => {
    const two = { ...vault('v2'), parts: [boxMesh(10, 10, 10), { ...boxMesh(10, 10, 10), positions: boxMesh(10, 10, 10).positions.map((p, i) => (i % 3 === 0 ? p + 40 : p)) }] }
    set({ plate: [two], selection: 'v2', selectedIds: ['v2'] })
    expect(await splitSelectedToObjects(loader)).toBeGreaterThan(1)
    expect(get().plate.every((p) => p.source?.modelId === VAULT.modelId)).toBe(true)
    set({ plate: [own('mine'), vault('vault')], selection: 'mine', selectedIds: ['mine', 'vault'] })
    expect(await mergeSelected(loader)).toBe(true)
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]?.source?.modelId).toBe(VAULT.modelId)
  })
})

describe('the Vault tag in .sx3mf files', () => {
  const bed = { widthMm: 256, depthMm: 256 }
  it('comes back on reopen from the root model, as the library stamps it', async () => {
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [own('a')], settings: { sequence: 'by-layer' } }], bed, settings: {}, sx: { ...VAULT, exportedBy: '' } })
    const back = await readProject(bytes, bed)
    const objects = back.plates.flatMap((p) => p.objects)
    expect(objects.length).toBeGreaterThan(0)
    expect(objects.every((o) => o.source?.modelId === VAULT.modelId)).toBe(true)
  })

  it('leaves a file without sx:Listing untagged', async () => {
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [own('a')], settings: { sequence: 'by-layer' } }], bed, settings: {}, sx: { exportedBy: '' } })
    const back = await readProject(bytes, bed)
    expect(back.plates.flatMap((p) => p.objects).some((o) => o.source?.modelId)).toBe(false)
  })
})
