// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { pushPreview } from '../src/geom/cad'
import { applyPush, onFace, parseDistance, pickPushFace, pushWords, throughThickness } from '../src/cad/push'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('push-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
// A 20 mm cube standing at (100, 100) on the bed: the top face is triangles 2 and 3, at z 20.
const at = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })

beforeEach(() => {
  set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: at }], selection: 'a', selectedIds: ['a'] })
})

describe('push words', () => {
  it('says what a push does in plain words', () => {
    expect(pushWords(5, 20)).toBe('Adds 5 mm')
    expect(pushWords(-3, 20)).toBe('Cuts 3 mm')
    expect(pushWords(-2.5, 20)).toBe('Cuts 2.5 mm')
    expect(pushWords(-20, 20)).toBe('Opens a hole')
    expect(pushWords(-25, 20)).toBe('Opens a hole')
    expect(pushWords(-25, null)).toBe('Cuts 25 mm')
    expect(pushWords(null, 20)).toMatch(/^Drag the face/)
  })

  it('reads typed distances, commas included', () => {
    expect(parseDistance('5')).toBe(5)
    expect(parseDistance(' -2,5 ')).toBe(-2.5)
    expect(parseDistance('')).toBeNull()
    expect(parseDistance('abc')).toBeNull()
  })

  it('finds the far side of the body behind a face', () => {
    const p = boxMesh(20, 20, 12)
    expect(throughThickness(p, at, [100, 100, 12], [0, 0, 1])).toBeCloseTo(12)
    expect(throughThickness(p, at, [105, 90, 6], [0, -1, 0])).toBeCloseTo(20)
    expect(throughThickness(p, at, [300, 300, 12], [0, 0, 1])).toBeNull()
  })
})

describe('push and pull on a body', () => {
  it('picks the top face, previews a 1 mm prism, and pulls it up in one undo step', async () => {
    const face = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 20] })
    expect(face.frame.normal[2]).toBeCloseTo(1)
    expect(face.thicknessMm).toBeCloseTo(20)
    expect(onFace(face, [95, 104, 20], [0, 0, 1])).toBe(true)
    expect(onFace(face, [95, 104, 19], [0, 0, 1])).toBe(false)
    const prism = await pushPreview(face, 1)
    expect(prism.operation).toBe('join')
    expect(prism.tool.indices.length).toBeGreaterThan(0)
    const h = createHistory(appStore)
    const before = get().plate[0]!.parts[0]
    const r = await applyPush(host, face, 5)
    expect(r.message).toBe('Added 2.00 cm³ to Block.')
    expect(r.moved.distanceMm).toBe(5)
    const after = get().plate[0]!.parts[0]!
    expect(after).not.toBe(before)
    // The body stays in its own frame: the top is now at 25 mm.
    expect(Math.max(...Array.from(after.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(25)
    expect(h.canUndo()).toBe(true)
    h.undo()
    expect(get().plate[0]!.parts[0]).toBe(before)
    expect(h.canUndo()).toBe(false)
    h.dispose()
  })

  it('cuts by pushing in and shows the engine error as is', async () => {
    const face = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 20] })
    const r = await applyPush(host, face, -4)
    expect(r.message).toBe('Cut 1.60 cm³ out of Block.')
    const again = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 16] })
    await expect(applyPush(host, again, -40)).rejects.toThrow(/removes the whole body/)
  })
})
