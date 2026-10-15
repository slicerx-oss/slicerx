// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { apply, bounds, compose, identity } from '../src/plate/transform'
import { addPrimitiveVolume, removeVolume, requestVolumes, setModifierSetting, setVolumeRole, setVolumeSize, setVolumeTrs, useObjectAsVolume, volumeSize } from '../src/plate/volumes'
import { get, set, type PlateEntry } from '../src/state/store'
import { history } from '../src/plate/history'
import { clipboard, copySelection, pasteVolumesInto } from '../src/plate/clipboard'

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: `h-${name}-${Math.random()}`, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: 1, triangles: 12 })) }),
}

async function entry(id: string, size: number, position: [number, number, number]): Promise<PlateEntry> {
  const part = boxMesh(size, size, size)
  const handle = await loader.loadParts(id, [part])
  return { id, name: id, handle, parts: [part], colors: ['#bd93f9'], transform: compose({ position, rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

beforeEach(async () => {
  set({ plate: [await entry('a', 30, [100, 100, 15])], activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], objectSettings: {}, selection: 'a', selectedIds: ['a'], slice: { status: 'idle' } })
  history().clear()
})

describe('volumes', () => {
  it('adds a volume at the middle of the object and sends it placed in bed coordinates', async () => {
    await addPrimitiveVolume(loader, 'negative', 'box')
    const a = get().plate[0]!
    expect(a.volumes).toHaveLength(1)
    const [req] = requestVolumes(a)
    expect(req).toMatchObject({ role: 'negative', name: 'Negative volume 1' })
    // Box parts are centered on the origin or not; the volume's center lands on the object's center.
    const b = bounds([a.volumes![0]!.part], req!.transform!)!
    const objectBox = bounds(a.parts, a.transform)!
    for (let i = 0; i < 3; i++) expect((b.min[i]! + b.max[i]!) / 2).toBeCloseTo((objectBox.min[i]! + objectBox.max[i]!) / 2, 3)
  })

  it('moves with the object', async () => {
    await addPrimitiveVolume(loader, 'support_blocker', 'cylinder')
    const before = requestVolumes(get().plate[0]!)[0]!.transform!
    set({ plate: get().plate.map((p) => ({ ...p, transform: compose({ position: [150, 100, 15], rotation: [0, 0, 0], scale: [1, 1, 1] }) })) })
    const after = requestVolumes(get().plate[0]!)[0]!.transform!
    expect(after[12]! - before[12]!).toBeCloseTo(50)
  })

  it('edits position, size, role and removal', async () => {
    await addPrimitiveVolume(loader, 'negative', 'box')
    const id = get().plate[0]!.volumes![0]!.id
    setVolumeTrs('a', id, { position: [1, 2, 3] })
    expect(apply(get().plate[0]!.volumes![0]!.local, [0, 0, 0])).toEqual([1, 2, 3].map((n) => expect.closeTo(n, 5)))
    setVolumeSize('a', id, 0, 8, false)
    expect(volumeSize(get().plate[0]!.volumes![0]!)[0]).toBeCloseTo(8)
    setVolumeSize('a', id, 1, 12, true)
    const s = volumeSize(get().plate[0]!.volumes![0]!)
    expect(s[1]).toBeCloseTo(12)
    setVolumeRole('a', id, 'support_enforcer')
    expect(get().plate[0]!.volumes![0]).toMatchObject({ role: 'support_enforcer', name: 'Support enforcer 1' })
    removeVolume('a', id)
    expect(get().plate[0]!.volumes).toEqual([])
  })

  it('a modifier carries its own settings into the request, and another role drops them', async () => {
    await addPrimitiveVolume(loader, 'modifier', 'box')
    const id = get().plate[0]!.volumes![0]!.id
    expect(requestVolumes(get().plate[0]!)[0]).not.toHaveProperty('settings')
    setModifierSetting('a', id, 'sparse_infill_density', '60%')
    setModifierSetting('a', id, 'wall_loops', 5)
    expect(requestVolumes(get().plate[0]!)[0]).toMatchObject({ role: 'modifier', settings: { sparse_infill_density: '60%', wall_loops: 5 } })
    setModifierSetting('a', id, 'wall_loops', undefined)
    expect(get().plate[0]!.volumes![0]!.settings).toEqual({ sparse_infill_density: '60%' })
    setVolumeRole('a', id, 'negative')
    expect(requestVolumes(get().plate[0]!)[0]).not.toHaveProperty('settings')
    expect(get().plate[0]!.volumes![0]!.settings).toBeUndefined()
  })

  it('turns another object into a volume where it stands, and removes it from the plate', async () => {
    set({ plate: [...get().plate, await entry('cutter', 10, [110, 100, 15])] })
    await useObjectAsVolume(loader, 'negative', 'cutter', 'a')
    const s = get()
    expect(s.plate.map((p) => p.id)).toEqual(['a'])
    const v = s.plate[0]!.volumes![0]!
    const b = bounds([v.part], requestVolumes(s.plate[0]!)[0]!.transform!)!
    expect((b.min[0]! + b.max[0]!) / 2).toBeCloseTo(110, 3)
    expect((b.min[2]! + b.max[2]!) / 2).toBeCloseTo(20, 3)
    expect(identity()).toHaveLength(16)
  })

  it('needs a selected object and a different source', async () => {
    await expect(useObjectAsVolume(loader, 'negative', 'a', 'a')).rejects.toThrow(/different/)
    set({ selection: null, plate: [] })
    await expect(addPrimitiveVolume(loader, 'negative', 'box')).rejects.toThrow(/Select an object/)
  })

  it('restores the source and removes its volume together in one Undo', async () => {
    const source = await entry('cutter', 10, [110, 100, 15])
    set({ plate: [...get().plate, source] })
    history().clear()
    await useObjectAsVolume(loader, 'negative', 'cutter', 'a')
    expect(get().plate).toHaveLength(1)
    expect(history().snapshots()).toHaveLength(1)
    expect(history().undo()).toBe(true)
    expect(get().plate).toHaveLength(2)
    expect(get().plate[0]?.volumes).toBeUndefined()
    expect(get().plate[1]).toBe(source)
    expect(history().redo()).toBe(true)
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]?.volumes).toHaveLength(1)
  })

  it('does not consume a source when its target disappears during mesh loading', async () => {
    const source = await entry('cutter', 10, [110, 100, 15])
    set({ plate: [...get().plate, source] })
    const delayed = { loadParts: async (name: string, parts: MeshPart[]) => {
      set({ plate: get().plate.filter((p) => p.id !== 'a') })
      return loader.loadParts(name, parts)
    } }
    await expect(useObjectAsVolume(delayed, 'negative', 'cutter', 'a')).rejects.toThrow(/changed|removed/i)
    expect(get().plate).toEqual([source])
  })

  it('keeps a converted source\'s surviving copies and shared settings valid on other plates', async () => {
    const source = { ...await entry('cutter', 10, [110, 100, 15]), partSettings: { body: { wall_loops: 3 } } }
    const { partSettings: _settings, ...mesh } = source
    const copy = { ...mesh, id: 'copy', instanceOf: 'cutter' }
    set({ plate: [...get().plate, source], objectSettings: { cutter: { wall_loops: 4 } }, plates: [get().plates[0]!, { id: 'other', name: 'Other', objects: [copy], settings: {} }] })
    history().clear()
    await useObjectAsVolume(loader, 'negative', 'cutter', 'a')
    const survivor = get().plates[1]!.objects[0]!
    expect(survivor.instanceOf).toBeUndefined()
    expect(survivor.partSettings).toEqual(source.partSettings)
    expect(get().objectSettings).toEqual({ copy: { wall_loops: 4 } })
    history().undo()
    expect(get().plates[1]!.objects[0]).toBe(copy)
    expect(get().objectSettings).toEqual({ cutter: { wall_loops: 4 } })
  })

  it('copies a volume directly without replacing the clipboard, preserving the UI paste placement', async () => {
    await addPrimitiveVolume(loader, 'modifier', 'box')
    const volume = get().plate[0]!.volumes![0]!
    const target = await entry('other', 20, [50, 60, 10])
    set({ plate: [...get().plate, target] })
    copySelection()
    const copied = clipboard()
    history().clear()
    const same = pasteVolumesInto([volume], 'a', 'a')
    expect(same).toHaveLength(1)
    expect(get().plate[0]!.volumes![1]!.local).toEqual(volume.local)
    expect(clipboard()).toBe(copied)
    history().undo()
    const other = pasteVolumesInto([volume], 'a', 'other')
    expect(other).toHaveLength(1)
    const pasted = get().plate[1]!.volumes![0]!
    const box = bounds([pasted.part], pasted.local)!
    const body = bounds(target.parts, identity())!
    expect(box.min[0]).toBeCloseTo(body.max[0])
    expect(box.min[1]).toBeCloseTo(body.min[1])
    expect(box.min[2]).toBeCloseTo(body.min[2])
    expect(clipboard()).toBe(copied)
    expect(history().snapshots()).toHaveLength(1)
  })
})
