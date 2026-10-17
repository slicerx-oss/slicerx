// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open itself, end to end in the store: a plain 3MF whose objects are stacked bands of one model opens as one
// object with those parts, at the height the file gives each, the open note says so, and the note's Keep separate puts
// the file's objects back at the same heights. (open-join.test.ts covers the pieces; this is the path that joins them,
// moved here from the open-3mf-stacked Playwright spec.)
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { bounds } from '../src/plate/transform'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

// Which objects touch is the fit check's measurement (fit-check.test.ts and the wasm kernel); here it reports the one
// pair the bands make, so this test is about what the open does with a touching pair.
vi.mock('../src/plate/fit-run', () => ({
  checkTouches: async (entries: { id: string }[]) => (entries.length === 2 ? [{ ids: [entries[0]!.id, entries[1]!.id], gapMm: 0, transforms: [], from: [0, 0, 0], to: [0, 0, 0] }] : []),
}))

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

/** A 10 mm cube with its corner at (0, 0, z), as one named 3MF object. */
function cube(id: number, name: string, z: number): string {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<object id="${id}" name="${name}" type="model"><mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c! + z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** Two bands of one model as separate objects, the upper sitting on the lower: they touch. */
const STACK = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube(1, 'Base band', 0)}${cube(2, 'Top band', 10)}</resources><build><item objectid="1"/><item objectid="2"/></build></model>`

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const file = () => buf(zip([{ name: '3D/3dmodel.model', data: STACK }]))

/** The lowest world Z of each part on the plate, by part name. */
function feet(): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of get().plate) for (const p of e.parts) out.set(p.name, bounds([p], e.transform)!.min[2]!)
  return out
}

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, toast: null, unsavedPrompt: null }))
  await profileReady()
})

describe('a plain 3MF with stacked objects', () => {
  it('opens as one object with the bands as parts at the file heights, and Keep separate splits them at the same heights', async () => {
    await openModelBytes(host, 'x-mark-2color.3mf', file(), undefined, { fresh: true })
    expect(get().plate.map((e) => [e.name, e.parts.length])).toEqual([['x-mark-2color', 2]])
    const joined = feet()
    expect(joined.get('Base band')).toBeCloseTo(0, 2)
    expect(joined.get('Top band')).toBeCloseTo(10, 2)

    const note = get().toast
    expect(note?.text).toMatch(/2 of its objects touch, so they were loaded as one object with parts/)
    expect(note?.action?.label).toBe('Keep separate')
    note!.action!.run()
    await new Promise((r) => setTimeout(r, 20))
    expect(get().plate.map((e) => [e.name, e.parts.length])).toEqual([['Base band', 1], ['Top band', 1]])
    const apart = feet()
    expect(apart.get('Base band')).toBeCloseTo(0, 2)
    expect(apart.get('Top band')).toBeCloseTo(10, 2)
  })
})
