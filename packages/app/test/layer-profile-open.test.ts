// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project with plates of their own layer heights opens with each plate's profile on that plate, through the app's
// open path: a saved project reopens with no note about its profiles, objects whose profiles really differ and heights
// the printer does not print each get a line in the open note, and geometry added to plates already there brings none.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { projectFiles, writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { answerOpenProject } from '../src/project/open-ask'
import { allPlates } from '../src/plate/plates'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const box = (id: string, x: number, h: number): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(10, 10, h), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const FIRST: [number, number][] = [[0.2, 0.12], [4, 0.12], [8, 0.24]]
const SECOND: [number, number][] = [[0.2, 0.2], [3, 0.1]]

/** Two plates: the first with a tall and a short object sharing FIRST, the second with one object on SECOND. */
const twoPlates = (first = FIRST, second = SECOND) =>
  buf(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [box('tall', 50, 10), box('short', 100, 6)], settings: { layerProfile: first } }, { id: 'p2', name: 'Plate 2', objects: [box('solo', 80, 5)], settings: { layerProfile: second } }], bed, settings: {} }))

/** A one-plate project whose profile part is `text`, as another slicer's file might give it. */
const withProfiles = (text: string) =>
  buf(zip(projectFiles({ plates: [{ id: 'p1', name: 'Plate 1', objects: [box('a', 50, 10), box('b', 100, 6)], settings: {} }], bed, settings: {} }).concat([{ name: 'Metadata/layer_heights_profile.txt', data: text }])))

const profiles = () => allPlates().map((p) => p.settings.layerProfile)
const note = () => get().openNote?.text ?? ''

beforeEach(() => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, openNote: null, toast: null, unsavedPrompt: null, overrides: { min_layer_height: [0.08], max_layer_height: [0.28], initial_layer_print_height: 0.2 } }))
  startDirtyTracking()
  markClean()
})

describe("a project's own layer heights, opened", () => {
  it("land on their own plates, plate 2's on plate 2, with no note for the app's own file", async () => {
    await openModelBytes(host, 'two.3mf', twoPlates(), undefined, { fresh: true })
    expect(allPlates().map((p) => p.objects.map((o) => o.name))).toEqual([['tall', 'short'], ['solo']])
    // The tall object carries the whole curve; the short one's, cut at its 6 mm top, agrees with it and adds no note.
    expect(profiles()).toEqual([[[0, 0.12], [0.2, 0.12], [4, 0.12], [8, 0.24], [10, 0.24]], [[0, 0.2], [0.2, 0.2], [3, 0.1], [5, 0.1]]])
    expect(note()).not.toMatch(/layer height profile/)
  })

  it('name the tallest object when the objects really differ', async () => {
    await openModelBytes(host, 'mixed.3mf', withProfiles('object_id=1|0;0.2;10;0.2\nobject_id=2|0;0.1;6;0.1\n'), undefined, { fresh: true })
    expect(profiles()[0]).toEqual([[0, 0.2], [10, 0.2]])
    expect(note()).toMatch(/Its objects have different layer height profiles, and layers are shared on a plate, so the plate uses the one of a, the tallest\./)
  })

  it("keep heights inside the printer's limits and say so", async () => {
    await openModelBytes(host, 'thin.3mf', withProfiles('object_id=1|0;0.02;10;0.5\n'), undefined, { fresh: true })
    expect(profiles()[0]).toEqual([[0, 0.08], [10, 0.28]])
    expect(note()).toMatch(/Its layer height profile asks for layers this printer does not print, so those use the nearest it does \(0\.08 to 0\.28 mm\)\./)
  })

  it('say when a long profile was simplified', async () => {
    const pairs: string[] = []
    for (let i = 0; i <= 1000; i++) pairs.push(`${(i / 100).toFixed(2)};${i >= 400 && i < 420 ? '0.08' : '0.2'}`)
    await openModelBytes(host, 'dense.3mf', withProfiles(`object_id=1|${pairs.join(';')}\n`), undefined, { fresh: true })
    expect(profiles()[0]!.length).toBeLessThanOrEqual(200)
    expect(note()).toMatch(/Some points of its layer height profile were left out/)
  })

  it('drop layer heights left on a plate emptied by hand, opened onto it, even when the file has none', async () => {
    const plain = () => buf(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [box('a', 50, 10)], settings: {} }], bed, settings: {} }))
    for (const fresh of [true, false]) {
      set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, settings: { layerProfile: [[0, 0.1]] as [number, number][] } })) }))
      await openModelBytes(host, 'plain.3mf', plain(), undefined, { fresh })
      expect(get().plate.map((p) => p.name)).toEqual(['a'])
      expect(profiles()).toEqual([undefined])
    }
  })

  it('are not taken when the file only adds its geometry to plates already there', async () => {
    set({ plate: [box('mine', 150, 4)] })
    const opening = openModelBytes(host, 'two.3mf', twoPlates())
    await Promise.race([opening, expect.poll(() => get().projectOpenAsk).not.toBeNull()])
    if (get().projectOpenAsk) answerOpenProject('geometry')
    await opening
    expect(get().plate.map((p) => p.name)).toContain('tall')
    expect(profiles().every((p) => p === undefined)).toBe(true)
  })
})
