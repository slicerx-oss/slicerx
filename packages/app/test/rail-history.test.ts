// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A rail in the object's history list, as a person sees it: the one call adds two steps, the posts (named with their
// count) and the bar, and the rail is a part of its own on the plate in the filament it was given.
import type { MeshHandle } from '@slicerx/contracts'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { HistorySteps } from '../src/cad/history/history-panel'
import { HostContext } from '../src/host'
import { createHistory } from '../src/plate/history'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('rail-history-replies', { compressed: true, freshCache: true })

Element.prototype.scrollIntoView = () => {}

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] })
const slicer = { loadParts: async (id: string) => handle(id) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never

beforeAll(() => useDesignHost(slicer))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))
afterEach(() => cleanup())

type Body = { design: string; volumeMm3: number; rail?: { posts: number; part: number } }
const output = async (name: string, args: Record<string, unknown>): Promise<Body> => ((await runCall(name, args)) as { output: Body }).output

it('shows a rail round a tray top as its posts and its bar, a part of its own in its filament', async () => {
  const { design } = await output('design.new', { name: 'Tray' })
  await output('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5 })
  const r = await output('geom.rail', { design, face: { point: [0, 0, 5] }, height_mm: 3, name: 'Railing', slot: 2 })
  expect(r.rail).toMatchObject({ part: 1 })
  const n = r.rail!.posts

  render(createElement(HostContext.Provider, { value: HOST }, createElement(HistorySteps, { objectId: design })))
  expect(screen.getByText(`Rail posts, ${n}`)).toBeTruthy()
  expect(screen.getByText('Rail bar')).toBeTruthy()
  // each a step of its own, edited, moved or turned off on its own
  expect(screen.getByRole('button', { name: `Edit Rail posts, ${n}` })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Edit Rail bar' })).toBeTruthy()
  const entry = get().plate.find((p) => p.id === design)!
  expect(entry.history!.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'shape.extrude', 'shape.extrude'])
  expect(entry.parts.map((p) => [p.name, p.slot])).toEqual([['Body', 1], ['Railing', 2]])
}, 60_000)

it('takes a rail off with one undo of the app and puts it back with one redo', async () => {
  const { design } = await output('design.new', { name: 'Tray' })
  await output('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5 })
  const undo = createHistory()
  try {
    await output('geom.rail', { design, face: { point: [0, 0, 5] }, height_mm: 3 })
    const entry = () => get().plate.find((p) => p.id === design)!
    expect(entry().history!.steps).toHaveLength(3)
    expect(undo.undo()).toBe(true)
    expect(entry().history!.steps).toHaveLength(1)
    expect(entry().parts.map((p) => p.name)).toEqual(['Body'])
    expect(undo.redo()).toBe(true)
    expect(entry().history!.steps.map((s) => s.label)).toEqual([undefined, expect.stringMatching(/^Rail posts, \d+$/), 'Rail bar'])
    expect(entry().parts).toHaveLength(2)
  } finally {
    undo.dispose()
  }
}, 60_000)

