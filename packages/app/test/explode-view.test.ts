// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded view (the Spread control over the view) is display only: the objects the engine slices, the mesh export, the
// undo history and unsaved changes never see it, it spreads only selected objects of 2 parts or more, and it goes back
// to 0 when the selection changes or a project opens. The app link reads and sets it with the state read back.
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { exportTargets, meshExportBytes } from '../src/export/mesh'
import { explodeShown, explodeSpec, explodeTargets, setExplode } from '../src/plate/explode'
import { history } from '../src/plate/history'
import { compose } from '../src/plate/transform'
import { isDirty, markClean, startDirtyTracking } from '../src/project/unsaved'
import { inputsChanged } from '../src/state/slice-inputs'
import { plateObjects } from '../src/state/slice-plate'
import { get, set, type PlateEntry } from '../src/state/store'

const cube = (x: number) => ({ name: `p${x}`, slot: 1, positions: new Float32Array([x, 0, 0, x + 10, 0, 0, x, 10, 0, x, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3]) })
const entry = (id: string, parts: number): PlateEntry =>
  ({ id, name: `${id}.3mf`, handle: { id: `h-${id}`, name: id, parts: [] }, parts: Array.from({ length: parts }, (_, i) => cube(i * 10)), colors: ['#ffffff'], transform: compose({ position: [40, 40, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }) as unknown as PlateEntry

const slicer = { loadModel: async () => { throw new Error('nothing here loads a model') } }

beforeEach(() => {
  set({ plate: [entry('kit', 3), entry('solo', 1)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: 'kit', selectedIds: ['kit'], explode: { spread: 0, axis: 'radial' }, revealHold: false })
})

describe('exploded view', () => {
  it('spreads only the selected objects with 2 parts or more', () => {
    expect(explodeTargets()).toEqual(['kit'])
    expect(explodeShown(get(), false)).toBe(true)
    // the slice's toolpaths stand in for the models: nothing to spread
    expect(explodeShown(get(), true)).toBe(false)
    set({ selection: 'solo', selectedIds: ['solo'] })
    expect(explodeTargets()).toEqual([])
    expect(explodeShown(get(), false)).toBe(false)
    set({ selection: 'kit', selectedIds: ['kit', 'solo'] })
    setExplode({ spread: 60, axis: 'z' })
    expect(explodeSpec(get(), false)).toEqual({ ids: ['kit'], spread: 60, axis: 'z' })
    expect(explodeSpec(get(), true)).toBeNull()
  })

  it('slices, exports and saves the parts where they are, whatever the spread', async () => {
    const whole = await plateObjects(slicer, get(), get().plates[0], get().plate)
    const stl = meshExportBytes(exportTargets('plate'), 'stl')
    const before = get()
    setExplode({ spread: 100, axis: 'x' })
    expect(get().explode).toEqual({ spread: 100, axis: 'x' })
    expect(await plateObjects(slicer, get(), get().plates[0], get().plate)).toEqual(whole)
    expect(meshExportBytes(exportTargets('plate'), 'stl')).toEqual(stl)
    // no slice input moved, so no new slice, and the plate the project saves is the same object
    expect(inputsChanged(before, get())).toBe(false)
    expect(get().plate).toBe(before.plate)
  })

  it('is no edit: no undo step and no unsaved changes', () => {
    const h = history()
    startDirtyTracking()
    markClean()
    setExplode({ spread: 40 })
    setExplode({ axis: 'y' })
    expect(isDirty()).toBe(false)
    expect(h.canUndo()).toBe(false)
    // while a real edit is both
    set({ plate: [...get().plate, entry('more', 2)] })
    expect(isDirty()).toBe(true)
  })

  it('goes back to 0 when the selection changes or a project opens, and keeps through the same selection', () => {
    setExplode({ spread: 50, axis: 'z' })
    // the same object picked again (a new array, the same ids)
    set({ selection: 'kit', selectedIds: ['kit'] })
    expect(get().explode.spread).toBe(50)
    set({ selection: 'solo', selectedIds: ['solo'] })
    expect(get().explode).toEqual({ spread: 0, axis: 'z' })
    set({ selection: 'kit', selectedIds: ['kit'] })
    setExplode({ spread: 30 })
    set({ revealHold: true })
    expect(get().explode.spread).toBe(0)
  })

  it('clamps and rounds the spread', () => {
    setExplode({ spread: 140 })
    expect(get().explode.spread).toBe(100)
    setExplode({ spread: 33.6 })
    expect(get().explode.spread).toBe(34)
    setExplode({ spread: -5 })
    expect(get().explode.spread).toBe(0)
  })
})

describe('app link exploded view', () => {
  const refused = async (args: Record<string, unknown>) => {
    const e = await runCall('explode.set', args).catch((x: unknown) => x)
    expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
    return (e as LinkError).code
  }

  it('reads and sets only how the view draws', () => {
    expect(APP_LINK_METHODS['explode.get']).toBe('read')
    expect(APP_LINK_METHODS['explode.set']).toBe('read')
  })

  it('reads the spread, its targets, and sets it with the state read back', async () => {
    expect(await runCall('explode.get', {})).toEqual({ spread: 0, axis: 'radial', targets: [{ id: 'kit', name: 'kit.3mf', parts: 3 }], drawn: null })
    expect(await runCall('explode.set', { spread: 60, axis: 'z' })).toMatchObject({ spread: 60, axis: 'z', targets: [{ id: 'kit' }] })
    expect(get().explode).toEqual({ spread: 60, axis: 'z' })
    expect(await runCall('explode.set', { axis: 'x' })).toMatchObject({ spread: 60, axis: 'x' })
  })

  it('refuses a bad call and a spread with nothing to spread, changing nothing', async () => {
    expect(await refused({})).toBe('invalid_input')
    expect(await refused({ spread: 120 })).toBe('invalid_input')
    expect(await refused({ spread: '50' })).toBe('invalid_input')
    expect(await refused({ axis: 'w' })).toBe('invalid_input')
    expect(await refused({ spread: 10, ids: ['kit'] })).toBe('invalid_input')
    set({ selection: 'solo', selectedIds: ['solo'] })
    expect(await refused({ spread: 50 })).toBe('not_found')
    expect(get().explode).toEqual({ spread: 0, axis: 'radial' })
  })
})
