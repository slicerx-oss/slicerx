// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A broken step's reason in the step list is plain words: the replay drops the engine's operation names before it
// and keeps a field key in lower case, and the list names or drops that key as the tools do ("lengthMm: the thread
// needs ..." reads "The thread needs ..."). Against the geometry engine (live wasm when built, recorded replies
// otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { applyExtrude, BED_FRAME } from '../src/cad/cad-ops'
import { HistorySteps } from '../src/cad/history/history-panel'
import { applyShell, applyThread } from '../src/cad/holes'
import { beginEdit, cancelEdit, saveEdit } from '../src/cad/history/ops'
import { threadSpecFor } from '../src/cad/thread-spec'
import { threadFind } from '../src/geom/cad'
import { toGeom } from '../src/geom/client'
import { HostContext } from '../src/host'
import { clearanceFor } from '../src/plate/clearance'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('step-reason-words-replies', { compressed: true })

Element.prototype.scrollIntoView = () => {}

type V3 = [number, number, number]
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const slicer = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never
const entry = (id: string) => get().plate.find((p) => p.id === id)!

beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, objectTool: null, toast: null })
})

afterEach(() => {
  cancelEdit()
  cleanup()
  set({ plate: [], historyEdit: null, objectTool: null, toast: null })
})

/** The reason the step list shows under each broken step. */
function reasons(id: string): string[] {
  const el = render(createElement(HostContext.Provider, { value: HOST }, createElement(HistorySteps, { objectId: id }))).container
  return [...el.querySelectorAll('.cad-step-why')].map((p) => p.textContent!.trim())
}

describe('a broken step in the list', () => {
  it('reads a thread too short for one pitch without the engine key', async () => {
    await applyExtrude(slicer, { name: 'Plate', frame: BED_FRAME, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, spec: { distanceMm: 10, operation: 'new' } })
    const id = get().plate.at(-1)!.id
    await applyExtrude(slicer, { name: 'Hole', target: { objectId: id, partIndex: 0 }, frame: { ...BED_FRAME, origin: [0, 0, 10] }, shape: { type: 'circle', diameterMm: 6.8 }, placement: { center: [15, 10] }, spec: { distanceMm: 10, operation: 'cut' } })
    const e = entry(id)
    const p = e.parts[0]!
    let tri = -1
    for (let t = 0; t < p.indices.length / 3 && tri < 0; t++) {
      const v = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p.positions[p.indices[t * 3 + k]! * 3 + j]!))
      if (v.every((q) => Math.abs(Math.hypot(q[0]!, q[1]!) - 3.4) < 0.05) && Math.max(...v.map((q) => q[2]!)) - Math.min(...v.map((q) => q[2]!)) > 1) tri = t
    }
    const c = [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + p.positions[p.indices[tri * 3 + k]! * 3 + j]!, 0) / 3)
    const at: V3 = [c[0]! + e.transform[12]!, c[1]! + e.transform[13]!, c[2]!]
    const target = await threadFind({ mesh: toGeom(p), transform: e.transform }, { triangle: tri, at })
    const sized = threadSpecFor(target, { size: target.suggested, lengthMm: 2 }, clearanceFor(get()))
    const { suggested: _s, sizes: _all, ...place } = target
    await applyThread(slicer, id, 0, { op: 'thread.apply', thread: place, spec: sized.spec, label: sized.label })
    const made = entry(id).history!.steps[2]!.params
    if (made.op !== 'thread.apply') throw new Error('expected a thread step')
    const shorter = { ...made, spec: { ...made.spec, lengthMm: 0.001 } }
    await act(() => beginEdit(slicer, id, 2))
    await act(() => saveEdit(slicer, shorter))
    // kept as the engine names it, in lower case, never "LengthMm:"
    expect(entry(id).history!.steps[2]!.broken).toBe(`lengthMm: the thread needs at least one pitch of length (1.25 mm for ${target.suggested})`)
    expect(reasons(id)).toEqual([`The thread needs at least one pitch of length (1.25 mm for ${target.suggested}).`])
  })

  it('reads a shell too thick for its body as a sentence', async () => {
    set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'] })
    await applyShell(slicer, 'a', 0, { op: 'shell', open: [], wallMm: 2 })
    const made = entry('a').history!.steps[0]!.params
    if (made.op !== 'shell') throw new Error('expected a shell step')
    const thicker = { ...made, wallMm: 6 }
    await act(() => beginEdit(slicer, 'a', 0))
    await act(() => saveEdit(slicer, thicker))
    expect(entry('a').history!.steps[0]!.broken).toMatch(/^wallMm: the wall is too thick/)
    expect(reasons('a')).toEqual(['The wall is too thick for this body; try a thinner one.'])
  })
})
