// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A pattern step in the object's history list, as a person sees it: its name gives the count, and choosing it opens
// one Copies field (no unit) that changes the count in place, as a step with no tool panel of its own does.
import type { MeshHandle } from '@slicerx/contracts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { HistorySteps } from '../src/cad/history/history-panel'
import { HostContext } from '../src/host'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('feature-pattern-history-replies', { compressed: true, freshCache: true })

Element.prototype.scrollIntoView = () => {}

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] })
const slicer = { loadParts: async (id: string) => handle(id) }
const HOST = { kind: 'web', slicer, capabilities: { secureStorage: false } } as never

beforeAll(() => useDesignHost(slicer))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))
afterEach(() => cleanup())

type Body = { design: string; volumeMm3: number }
const output = async (name: string, args: Record<string, unknown>): Promise<Body> => ((await runCall(name, args)) as { output: Body }).output

it('shows a row of hatches as one step named with its count, and its Copies field changes the count', async () => {
  const { design } = await output('design.new', { name: 'Toy boat deck' })
  await output('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10 })
  await output('geom.subtract', { design, part: 0, solids: [{ type: 'box', min: [-14, -2, 8], max: [-10, 2, 10] }] })
  await output('geom.array', { design, steps: [2], spec: { kind: 'linear', count: 4, step: [8, 0, 0] } })

  render(createElement(HostContext.Provider, { value: HOST }, createElement(HistorySteps, { objectId: design })))
  const row = screen.getByRole('button', { name: 'Change Pattern of 4, 1 step' })
  expect(row.textContent).toBe('Pattern of 4, 1 step')
  fireEvent.click(row)
  const field = screen.getByRole('textbox', { name: 'Copies' }) as HTMLInputElement
  expect(field.value).toBe('4')
  expect(field.closest('label')!.textContent).toBe('Copies')
  await act(async () => {
    fireEvent.change(field, { target: { value: '2' } })
    fireEvent.keyDown(field, { key: 'Enter' })
  })
  await waitFor(() => expect(get().plate.find((p) => p.id === design)!.history!.steps[2]!.params).toMatchObject({ op: 'pattern', spec: { count: 2 } }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change Pattern of 2, 1 step' })).toBeTruthy())

  // a count that is no count says why, and the step stays as it was
  fireEvent.change(screen.getByRole('textbox', { name: 'Copies' }), { target: { value: '1' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Copies' }), { key: 'Enter' })
  expect(await screen.findByText(/A pattern has at least 2 copies/)).toBeTruthy()
}, 60_000)
