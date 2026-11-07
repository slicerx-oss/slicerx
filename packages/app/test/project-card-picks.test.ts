// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picks in the sketch panel's Project card, end to end through the card: a finished sketch's sources are read where
// that sketch is in the timeline; an edge on another body starts a projection of its own while the open one keeps
// its edges; edges picked before the tool opened all land in one projection; a projection removed while another
// pick is still projecting stays removed; a projection switched to reference while an edge adds to it stays
// reference; and an edge that answers after its projection was removed or ended neither brings it back nor reopens it.
import type { FaceFrame, ProjectSource, SketchLoop } from '@slicerx/cad-history'
import type { PickEvent } from '@slicerx/viewport'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { probeHandler } from '../src/plate/tools'
import { set, type PlateEntry } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const BED: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const square = (w: number): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [w, 0] }, { type: 'line', to: [w, w] }, { type: 'line', to: [0, w] }, { type: 'line', to: [0, 0] }] })

// the engine side of a pick, stood in: each projection is a square, and the sketch it is read at is noted
const asked: (string | undefined)[] = []
let wait: Promise<void> | null = null
vi.mock('../src/cad/project-sketch', async (load) => {
  const real = await load<typeof import('../src/cad/project-sketch')>()
  return {
    ...real,
    projectNow: async (_source: ProjectSource, _frame: unknown, sketch?: string) => {
      asked.push(sketch)
      if (wait) await wait
      return [square(4)]
    },
    edgeSource: async (e: Pick<PlateEntry, 'id'>, part: number, triangle: number, at: [number, number, number], to?: ProjectSource): Promise<ProjectSource> => {
      const edge = { a: at, b: [at[0] + 1, at[1], at[2]] as [number, number, number], face: [0, 0, 1] as [number, number, number], keys: [triangle, triangle + 1] as [number, number] }
      if (to?.kind === 'edges' && to.body === e.id && to.part === part) return { ...to, edges: [...to.edges, edge] }
      return { kind: 'edges', body: e.id, part, transform: I, edges: [edge] }
    },
  }
})
const { ProjectCard } = await import('../src/cad/project-card')
type Projected = import('../src/cad/project-card').Projected

const body = (id: string): PlateEntry => ({ id, name: id === 'a' ? 'Block' : 'Peg', handle: { id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [boxMesh(10, 10, 5)], colors: ['#bd93f9'], transform: [...I] })
const hit = (objectId: string, triangle = 0): PickEvent => ({ objectId, partIndex: 0, triangle, point: [1, 1, 5], bed: null }) as PickEvent

let root: Root | null = null
let el: HTMLElement | null = null
let state: Projected = { list: [], loops: [], next: 0 }
function Host({ start, sketch }: { start: Projected; sketch?: string }) {
  const [value, setValue] = useState(start)
  state = value
  return createElement(ProjectCard, { frame: BED, value, onChange: setValue, ...(sketch ? { sketch } : {}) })
}
function mount(start: Projected, sketch?: string): HTMLElement {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => root!.render(createElement(Host, { start, ...(sketch ? { sketch } : {}) })))
  return el
}
const press = async (card: HTMLElement, id: string) => {
  await act(async () => card.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click())
}
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
})

beforeEach(() => {
  asked.length = 0
  wait = null
  set({ plate: [body('a'), body('b')] })
})
afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
})

describe('picks in the Project card', () => {
  it('reads a finished sketch’s sources at that sketch, and an edge on another body starts its own projection', async () => {
    const card = mount({ list: [], loops: [], next: 0 }, 'k7')
    await press(card, 'sketch-project-edges')
    await act(async () => probeHandler()!(hit('a', 0)))
    await settle()
    await act(async () => probeHandler()!(hit('a', 2)))
    await settle()
    await act(async () => probeHandler()!(hit('b', 4)))
    await settle()
    expect(asked).toEqual(['k7', 'k7', 'k7'])
    expect(state.list.map((p) => [p.id, p.source.body, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([
      ['p1', 'a', 2],
      ['p2', 'b', 1],
    ])
  })

  it('puts edges picked before the tool opened into one projection', async () => {
    const card = mount({ list: [], loops: [], next: 0 })
    await press(card, 'sketch-project-edges')
    // two picks in one go, as the probe replays the ones made before it opened
    await act(async () => {
      probeHandler()!(hit('a', 0))
      probeHandler()!({ ...hit('a', 2), shift: true } as PickEvent)
    })
    await settle()
    await settle()
    expect(state.list.map((p) => [p.id, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([['p1', 2]])
  })

  it('keeps a projection removed while another pick was projecting removed', async () => {
    const p1 = { id: 'p1', source: { kind: 'silhouette', body: 'a' } as ProjectSource, mode: 'real' as const }
    const card = mount({ list: [p1], loops: [{ ...square(4), projected: 'p1' }], next: 1 })
    let release!: () => void
    wait = new Promise((r) => (release = r))
    await press(card, 'sketch-project-face')
    await act(async () => probeHandler()!(hit('b', 0)))
    // p1 goes while the face is still projecting
    await press(card, 'sketch-projection-p1-remove')
    wait = null
    release()
    await settle()
    expect(state.list.map((p) => p.id)).toEqual(['p2'])
    expect(state.loops.length).toBeGreaterThan(0)
    expect(state.loops.every((l) => l.projected === 'p2')).toBe(true)
  })

  it('keeps a projection switched to reference while an edge was adding to it', async () => {
    const card = mount({ list: [], loops: [], next: 0 })
    await press(card, 'sketch-project-edges')
    await act(async () => probeHandler()!(hit('a', 0)))
    await settle()
    let release!: () => void
    wait = new Promise((r) => (release = r))
    // a second edge adds to p1, and the person makes p1 reference while it is projecting
    await act(async () => probeHandler()!(hit('a', 2)))
    const row = card.querySelector<HTMLElement>('[data-testid="sketch-projection-p1"]')!
    const reference = [...row.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent === 'Reference')!
    await act(async () => reference.click())
    wait = null
    release()
    await settle()
    expect(state.list.map((p) => [p.id, p.mode, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([['p1', 'reference', 2]])
    expect(state.loops.length).toBeGreaterThan(0)
    expect(state.loops.every((l) => l.projected === 'p1' && (l as { construction?: true }).construction === true)).toBe(true)
  })

  it('drops an edge that was adding to a projection removed while it projected, and the next edge starts a new one', async () => {
    const card = mount({ list: [], loops: [], next: 0 })
    await press(card, 'sketch-project-edges')
    await act(async () => probeHandler()!(hit('a', 0)))
    await settle()
    expect(state.list.map((p) => p.id)).toEqual(['p1'])
    let release!: () => void
    wait = new Promise((r) => (release = r))
    // a second edge of the same body adds to p1, and p1 goes while it is projecting
    await act(async () => probeHandler()!(hit('a', 2)))
    await press(card, 'sketch-projection-p1-remove')
    wait = null
    release()
    await settle()
    expect(state.list).toEqual([])
    expect(state.loops).toEqual([])
    expect(card.querySelector('[data-testid="sketch-project-done"]')).toBeNull()
    await act(async () => probeHandler()!(hit('a', 4)))
    await settle()
    expect(state.list.map((p) => [p.id, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([['p2', 1]])
  })

  it('does not reopen an edges projection the person ended while its last edge was projecting', async () => {
    const card = mount({ list: [], loops: [], next: 0 })
    await press(card, 'sketch-project-edges')
    await act(async () => probeHandler()!(hit('a', 0)))
    await settle()
    let release!: () => void
    wait = new Promise((r) => (release = r))
    await act(async () => probeHandler()!(hit('a', 2)))
    // Edges off and on again starts a new projection while the edge for p1 is still projecting
    await press(card, 'sketch-project-edges')
    await press(card, 'sketch-project-edges')
    wait = null
    release()
    await settle()
    expect(state.list.map((p) => [p.id, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([['p1', 2]])
    expect(card.querySelector('[data-testid="sketch-project-done"]')).toBeNull()
    await act(async () => probeHandler()!(hit('a', 4)))
    await settle()
    expect(state.list.map((p) => [p.id, p.source.kind === 'edges' ? p.source.edges.length : 0])).toEqual([
      ['p1', 2],
      ['p2', 1],
    ])
    expect(card.querySelector('[data-testid="sketch-project-done"]')).not.toBeNull()
  })
})
