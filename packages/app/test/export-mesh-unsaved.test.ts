// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { compose } from '../src/plate/transform'
import { exportMesh, exportTargets, meshExportBytes } from '../src/export/mesh'
import { answerUnsaved, confirmDiscard, isDirty, markClean, startDirtyTracking } from '../src/project/unsaved'
import { profileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

const part = { name: 'p', slot: 1, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3]) }
const move = (x: number, sx = 1) => compose({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [sx, 1, 1] })
const entry = (id: string, transform = move(5)): PlateEntry =>
  ({ id, name: `${id}.stl`, handle: { id, name: id, parts: [] }, parts: [part], colors: ['#fff'], transform }) as unknown as PlateEntry

beforeEach(() => set({ plate: [entry('a'), entry('b')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: 'a', selectedIds: ['a'], unsavedPrompt: null }))

describe('mesh export', () => {
  it('writes a binary STL in plate coordinates', () => {
    const bytes = meshExportBytes(exportTargets('selection'), 'stl')
    expect(bytes.byteLength).toBe(84 + 2 * 50)
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(80, true)).toBe(2)
    // First vertex of the first triangle: the part's origin moved 5 mm along X.
    expect(dv.getFloat32(84 + 12, true)).toBeCloseTo(5)
  })

  it('flips the winding of a mirrored object so normals stay outward', () => {
    const z = (e: PlateEntry) => new DataView(meshExportBytes([e], 'stl').buffer).getFloat32(84 + 8, true)
    expect(Math.sign(z(entry('m', move(0, -1))))).toBe(-Math.sign(z(entry('n', move(0, 1)))) * -1)
  })

  it('writes OBJ with one o line per object and 1-based faces', () => {
    const text = new TextDecoder().decode(meshExportBytes(exportTargets('plate'), 'obj'))
    expect(text.match(/^o /gm)).toHaveLength(2)
    expect(text).toContain('f 1 3 2')
    expect(text).toContain('f 5 7 6')
    expect(text).toContain('v 5.00000 0.00000 0.00000')
  })

  it('exports the selection or the plate through the host and says when there is nothing', async () => {
    const saved: string[] = []
    const host = { files: { save: async (n: string) => (saved.push(n), { id: n, name: n, size: 1 }) } } as unknown as Host
    expect(await exportMesh(host, 'selection', 'stl')).toBe(true)
    expect(await exportMesh(host, 'plate', 'obj')).toBe(true)
    expect(saved).toEqual(['a.stl', 'plate.obj'])
    set({ plate: [] })
    expect(await exportMesh(host, 'plate', 'stl')).toBe(false)
    expect(get().toast?.text).toMatch(/nothing on the plate/)
  })
})

describe('unsaved changes', () => {
  it('is clean until the project changes, and asks before discarding', async () => {
    startDirtyTracking()
    markClean()
    expect(isDirty()).toBe(false)
    await expect(confirmDiscard('start over')).resolves.toBe(true)
    set({ plate: [entry('a'), entry('b'), entry('c')] })
    expect(isDirty()).toBe(true)
    const asked = confirmDiscard('start over')
    expect(get().unsavedPrompt).toEqual({ what: 'start over' })
    answerUnsaved(false)
    await expect(asked).resolves.toBe(false)
    expect(isDirty()).toBe(true)
    const again = confirmDiscard('quit')
    answerUnsaved(true)
    await expect(again).resolves.toBe(true)
    expect(isDirty()).toBe(false)
    expect(get().unsavedPrompt).toBeNull()
  })

  it('stays clean when the printer profile loads, so an untouched plate closes without asking', async () => {
    startDirtyTracking()
    markClean()
    set({ printerModel: { vendor: 'Bambu Lab', model: 'H2C' } })
    await profileReady()
    expect(get().profile).not.toBeNull()
    expect(isDirty()).toBe(false)
  })
})
