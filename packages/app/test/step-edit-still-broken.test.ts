// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a step's tool says when an edit of the step is saved: "Changed step N" when the step comes back done, and when
// it stays broken, that it is still broken and why, in the tools' plain words. Each family of step tools (hole and
// thread, fillet and shell, push and pull, sketch, the shape panel) is opened on a step from the history, as its Edit
// does. Against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, type Step, type StepStatus } from '@slicerx/cad-history'
import { applyExtrude, BED_FRAME } from '../src/cad/cad-ops'
import { CadPanel } from '../src/cad/cad-panel'
import { pickEdge } from '../src/cad/edge-api'
import { applyEdges, edgeParams } from '../src/cad/edges'
import { holeSpecFor } from '../src/cad/hole-sizes'
import { applyHole, applyShell, applyThread } from '../src/cad/holes'
import { beginEdit, cancelEdit, deleteStep, editedWords, setSuppressed } from '../src/cad/history/ops'
import { applyPush, pickPushFace } from '../src/cad/push'
import { PushTool, usePushTool } from '../src/cad/push-tool'
import { threadSpecFor } from '../src/cad/thread-spec'
import { holeFind, threadFind } from '../src/geom/cad'
import { toGeom } from '../src/geom/client'
import { HostContext } from '../src/host'
import { clearanceFor } from '../src/plate/clearance'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type CadTool } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('step-edit-still-broken-replies', { compressed: true })

// jsdom has no layout; the tool panel scrolls itself into view when it opens.
Element.prototype.scrollIntoView = () => {}

type V3 = [number, number, number]
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const slicer = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never
const TOP = { origin: [100, 100, 10] as V3, normal: [0, 0, 1] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3 }

// Each test starts with no picks: a face or edge left picked by an earlier test would be the first pick of the next
// tool that opens (takePicks), a call the test does not make on its own.
beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], subPicks: [], historyEdit: null, objectTool: null, toast: null })
})

afterEach(() => {
  cancelEdit()
  cleanup()
  set({ plate: [], subPicks: [], historyEdit: null, objectTool: null, toast: null })
})

/** A 30 x 20 x 10 block, with no history yet. */
const block = () => set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'], historyEdit: null })
const entry = (id = 'a') => get().plate.find((p) => p.id === id)!

/** A 30 x 20 x 10 plate with a d6.8 hole cut through its middle by a sketch, and a pick on the hole's wall. */
async function holed() {
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
  return { id, item: { mesh: toGeom(p), transform: e.transform }, pick: { triangle: tri, at } }
}

/** The push tool as the app mounts it: its state with the view, its panel on the right. */
function PushPanel() {
  usePushTool()
  return createElement(PushTool)
}

/** Opens step `index` of the object in its tool, as the step's Edit does. */
async function open(id: string, index: number) {
  await act(() => beginEdit(slicer, id, index))
  const tool = get().objectTool!
  render(createElement(HostContext.Provider, { value: HOST }, tool === 'push' ? createElement(PushPanel) : createElement(CadPanel, { tool: tool as CadTool })))
}

/**
 * Types `value` in the field and saves the edit with the named button, or with Enter in the field when `button` is
 * null; gives the toast once the edit has closed.
 */
async function save(field: string, value: string, button: string | null) {
  const input = await waitFor(() => {
    const el = document.getElementById(field)
    if (!el) throw new Error(`no field ${field}`)
    return el
  }, { timeout: 30_000 })
  fireEvent.change(input, { target: { value } })
  if (button === null) fireEvent.keyDown(input, { key: 'Enter' })
  else {
    const b = await waitFor(() => {
      const el = screen.getByRole('button', { name: button }) as HTMLButtonElement
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error(`${button} is off`)
      return el
    }, { timeout: 30_000 })
    fireEvent.click(b)
  }
  await waitFor(() => expect(get().historyEdit).toBeNull(), { timeout: 30_000 })
  return get().toast
}

describe('hole and thread', () => {
  it('a thread edited shorter than one pitch says it is still broken and why', async () => {
    const { id, item, pick } = await holed()
    const target = await threadFind(item, pick)
    const sized = threadSpecFor(target, { size: target.suggested, lengthMm: 2 }, clearanceFor(get()))
    const { suggested: _s, sizes: _all, ...place } = target
    await applyThread(slicer, id, 0, { op: 'thread.apply', thread: place, spec: sized.spec, label: sized.label })
    await open(id, 2)
    const t = await save('thread-length', '0.001', 'Cut thread')
    expect(t).toMatchObject({ tone: 'warn', text: `Step 3 is still broken: the thread needs at least one pitch of length (1.25 mm for ${target.suggested}). The change is saved.` })
    // the edit is kept, broken, as the list shows it
    expect(entry(id).history!.steps[2]!.broken).toBeDefined()
  })

  it('a hole edited to a size that cuts says "Changed step N"', async () => {
    const { id, item, pick } = await holed()
    const hole = await holeFind(item, pick)
    const sized = holeSpecFor({ purpose: 'custom', thread: 'M3', head: 'none', customMm: 7 }, clearanceFor(get()), hole)
    await applyHole(slicer, id, 0, { op: 'hole.apply', hole, spec: sized.spec, label: sized.label })
    await open(id, 2)
    const t = await save('hole-diameter', '8', 'Make hole')
    expect(t).toMatchObject({ tone: 'ok', text: 'Changed step 3 and ran the steps after it.' })
    expect(entry(id).history!.steps[2]!.broken).toBeUndefined()
  })
})

describe('fillet and shell', () => {
  it('a shell edited too thick says it is still broken and why', async () => {
    block()
    await applyShell(slicer, 'a', 0, { op: 'shell', open: [], wallMm: 2 })
    await open('a', 0)
    const t = await save('shell-wall', '6', 'Make shell')
    expect(t).toMatchObject({ tone: 'warn', text: 'Step 1 is still broken: the wall is too thick for this body; try a thinner one. The change is saved.' })
  })

  it('a fillet whose edge went with an earlier step is not saved by Enter while Round is off', async () => {
    block()
    // a chamfer, then a fillet on the edge between the chamfer's face and the side
    const pk = await pickEdge({ mesh: toGeom(entry().parts[0]!), transform: T }, { triangle: 2, at: [110, 109.5, 10] })
    await applyEdges(slicer, 'a', 0, edgeParams('chamfer', [pk.edge], 2, null))
    const part = entry().parts[0]!
    let tri = -1
    for (let t = 0; t < part.indices.length / 3 && tri < 0; t++) {
      const v = [0, 1, 2].map((k) => [0, 1, 2].map((j) => part.positions[part.indices[t * 3 + k]! * 3 + j]!))
      if (v.every((q) => Math.abs(q[1]! + q[2]! - 18) < 1e-3)) tri = t
    }
    const side = await pickEdge({ mesh: toGeom(part), transform: T }, { triangle: tri, at: [100, 109.9, 8.1] })
    await applyEdges(slicer, 'a', 0, edgeParams('fillet', [side.edge], 1, null))
    // the chamfer off and on keeps the fillet's faces by their keys; then the chamfer goes
    await setSuppressed(slicer, 'a', 0, true)
    await setSuppressed(slicer, 'a', 0, false)
    await deleteStep(slicer, 'a', 0)
    expect(entry().history!.steps[0]!.broken).toBeDefined()
    await open('a', 0)
    const words = 'A face or edge this step was made on is no longer on the part after an earlier change. Pick the face or edges again.'
    const input = await waitFor(() => {
      const el = document.getElementById('edge-size')
      if (!el) throw new Error('no radius field')
      return el
    }, { timeout: 30_000 })
    fireEvent.change(input, { target: { value: '1.5' } })
    // the preview says the edge is gone and Round is off; Enter in the radius follows the same rule
    await screen.findByText(words, undefined, { timeout: 30_000 })
    const round = screen.getByRole('button', { name: 'Round' }) as HTMLButtonElement
    expect(round.disabled || round.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 500))
    expect(get().historyEdit).not.toBeNull()
    expect(get().toast).toBeNull()
    expect((entry().history!.steps[0]!.params as { radiusMm: number }).radiusMm).toBe(1)
  })

  it('a fillet edited to a radius that fits says "Changed step N"', async () => {
    block()
    const pk = await pickEdge({ mesh: toGeom(entry().parts[0]!), transform: T }, { triangle: 2, at: [110, 109.5, 10] })
    await applyEdges(slicer, 'a', 0, edgeParams('fillet', [pk.edge], 1, null))
    await open('a', 0)
    const t = await save('edge-size', '1.5', 'Round')
    expect(t).toMatchObject({ tone: 'ok', text: 'Changed step 1 and ran the steps after it.' })
  })
})

/** The block with its top face pushed up 3 mm. */
async function pushed() {
  block()
  const p = entry().parts[0]!
  let tri = -1
  for (let t = 0; t < p.indices.length / 3 && tri < 0; t++) if ([0, 1, 2].every((k) => Math.abs(p.positions[p.indices[t * 3 + k]! * 3 + 2]! - 10) < 1e-6)) tri = t
  const f = await pickPushFace('a', 0, { triangle: tri, at: [100, 100, 10] })
  await applyPush(slicer, f, 3)
}

describe('push and pull', () => {
  it('a push edited through the whole body says it is still broken and why', async () => {
    await pushed()
    await open('a', 0)
    const t = await save('push-dist', '-12', 'Cut')
    expect(t).toMatchObject({ tone: 'warn', text: 'Step 1 is still broken: the cut removes the whole body. The change is saved.' })
  })

  it('a push edited so a later shell no longer fits says which step broke and why', async () => {
    await pushed()
    // a 6 mm shell on the block, 13 mm tall after the pull
    await applyShell(slicer, 'a', 0, { op: 'shell', open: [], wallMm: 6 })
    expect(entry().history!.steps.map((s) => s.broken ?? 'ok')).toEqual(['ok', 'ok'])
    await open('a', 0)
    // pushed in 3 mm the block is 7 mm tall, too thin for a 6 mm wall
    const t = await save('push-dist', '-3', 'Cut')
    expect(t).toMatchObject({ tone: 'warn', text: 'Step 1 changed; step 2 is now broken: the wall is too thick for this body; try a thinner one.' })
  })

  it('a push edited to another distance says "Changed step N"', async () => {
    await pushed()
    await open('a', 0)
    const t = await save('push-dist', '5', 'Pull out')
    expect(t).toMatchObject({ tone: 'ok', text: 'Changed step 1 and ran the steps after it.' })
  })
})

const square = (r: [number, number]) => [{ start: [-r[0], -r[1]] as [number, number], segments: [{ type: 'line' as const, to: [r[0], -r[1]] as [number, number] }, { type: 'line' as const, to: [r[0], r[1]] as [number, number] }, { type: 'line' as const, to: [-r[0], r[1]] as [number, number] }, { type: 'line' as const, to: [-r[0], -r[1]] as [number, number] }] }]

/** The block with a sketched rectangle wider than its top cut 5 mm into it. */
async function sketched() {
  block()
  await applyExtrude(slicer, { frame: TOP, shape: { type: 'sketch', loops: square([20, 15]) }, placement: {}, spec: { distanceMm: 5, operation: 'cut' }, target: { objectId: 'a', partIndex: 0 }, name: 'Sketch cut' })
  expect(entry().history!.steps.map((s) => s.params.op)).toEqual(['shape.extrude'])
}

describe('sketch', () => {
  it('a sketch cut edited deeper than the body says it is still broken and why', async () => {
    await sketched()
    await open('a', 0)
    const t = await save('sk-dist', '12', 'Extrude')
    expect(t).toMatchObject({ tone: 'warn', text: 'Step 1 is still broken: the cut removes the whole body. The change is saved.' })
  })

  it('a sketch cut edited to another depth says "Changed step N"', async () => {
    await sketched()
    await open('a', 0)
    const t = await save('sk-dist', '3', 'Extrude')
    expect(t).toMatchObject({ tone: 'ok', text: 'Changed step 1 and ran the steps after it.' })
  })
})

/** The block with a rectangle wider than its top cut 5 mm into it from the shape panel. */
async function shaped() {
  block()
  await applyExtrude(slicer, { name: 'Rectangle', target: { objectId: 'a', partIndex: 0 }, frame: TOP, shape: { type: 'rectangle', widthMm: 40, heightMm: 30 }, placement: { center: [0, 0] }, spec: { distanceMm: 5, operation: 'cut' } })
}

describe('the shape panel', () => {
  it('a shape cut edited deeper than the body says it is still broken and why', async () => {
    await shaped()
    await open('a', 0)
    const t = await save('cad-dist', '12', 'Cut')
    expect(t).toMatchObject({ tone: 'warn', text: 'Step 1 is still broken: the cut removes the whole body. The change is saved.' })
  })

  it('a shape cut edited to another depth says "Changed step N"', async () => {
    await shaped()
    await open('a', 0)
    const t = await save('cad-dist', '3', 'Cut')
    expect(t).toMatchObject({ tone: 'ok', text: 'Changed step 1 and ran the steps after it.' })
  })
})

describe('the words', () => {
  const done: StepStatus = { state: 'done' }
  it('name the broken step a later one waits on', () => {
    expect(editedWords(2, [done, { state: 'broken', message: 'The wall is too thick for this body; try a thinner one' }, { state: 'skipped' }])).toEqual({ message: 'Step 3 does not run while step 2 before it is broken. The change is saved.', warn: true })
  })

  it('give the reason in plain words', () => {
    expect(editedWords(0, [{ state: 'broken', message: 'faceReference: edge 1 has a missing face reference; repair the reference before editing' }])).toEqual({
      message: 'Step 1 is still broken: picked edge 1 is no longer on the part after an earlier change. Pick the edges again. The change is saved.',
      warn: true,
    })
    expect(editedWords(0, [{ state: 'broken', message: 'M8 needs a hole at least 6.8 mm across' }]).message).toBe('Step 1 is still broken: M8 needs a hole at least 6.8 mm across. The change is saved.')
    expect(editedWords(0, [{ state: 'broken' }]).message).toBe('Step 1 is still broken: this step failed. The change is saved.')
  })

  // the history as it was before the edit, by what each step was then
  const was = (...marks: ('ok' | 'broken' | 'off')[]): Step[] =>
    marks.map((m, i) => ({ id: `s${i}`, part: 0, transform: T, params: { op: 'shell', open: [], wallMm: 2 }, ...(m === 'broken' ? { broken: 'wallMm: the wall is too thick for this body' } : m === 'off' ? { suppressed: true } : {}) }))
  const cut: StepStatus = { state: 'broken', message: 'face.push: the cut removes the whole body' }
  const skipped: StepStatus = { state: 'skipped' }

  it('name a later step the edit broke, and count the fine steps that stop behind it', () => {
    expect(editedWords(0, [done, cut], was('ok', 'ok'))).toEqual({ message: 'Step 1 changed; step 2 is now broken: the cut removes the whole body.', warn: true })
    expect(editedWords(0, [done, cut, skipped], was('ok', 'ok', 'ok')).message).toBe('Step 1 changed; step 2 is now broken: the cut removes the whole body. Step 3 after it does not run.')
    expect(editedWords(1, [done, done, cut, skipped, { state: 'suppressed' }, skipped], was('ok', 'ok', 'ok', 'ok', 'off', 'ok')).message).toBe(
      'Step 2 changed; step 3 is now broken: the cut removes the whole body. 2 steps after it do not run.',
    )
  })

  it('leave out steps that were not fine before the edit', () => {
    // step 3 was broken already: the list shows it, and the edit says it changed
    expect(editedWords(1, [done, done, cut], was('ok', 'ok', 'broken'))).toEqual({ message: 'Changed step 2 and ran the steps after it.', warn: false })
    // step 3 was skipped behind a broken step 2, which the edit fixed
    expect(editedWords(1, [done, done, cut], was('ok', 'broken', 'ok')).message).toBe('Changed step 2 and ran the steps after it.')
    // with no history before, nothing is counted
    expect(editedWords(1, [done, done, cut]).message).toBe('Changed step 2 and ran the steps after it.')
  })
})
