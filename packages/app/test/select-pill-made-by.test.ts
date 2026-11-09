// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's selection pill names the step that made the one picked face. When the answer it is handed points at a step
// the object no longer has (the step is gone, the object has no history, or the object is gone), the pill shows no
// crumb and keeps working instead of taking Model down.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { History, Step, StepParams } from '@slicerx/cad-history'
import { EditionContext, NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { set, type PlateEntry } from '../src/state/store'
import type { MadeBy } from '../src/workspaces/design/use-made-by'

const answer = vi.hoisted(() => ({ made: null as MadeBy | null }))
vi.mock('../src/workspaces/design/use-made-by', async (actual) => ({ ...(await actual<object>()), useMadeBy: () => answer.made }))

const { SelectPill } = await import('../src/workspaces/design/select-pill')

const HOST = { kind: 'web', capabilities: { secureStorage: false }, files: { save: async () => undefined } } as unknown as Host
const mount = () => render(createElement(HostContext.Provider, { value: HOST }, createElement(EditionContext.Provider, { value: NEUTRAL }, createElement(SelectPill))))

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const pull = (d: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: d })
const step = (id: string, d: number): Step => ({ id, part: 0, transform: T, params: pull(d) })
const box = (history?: History): PlateEntry => ({ id: 'box', name: 'Box', handle: {} as PlateEntry['handle'], parts: [boxMesh(40, 20, 5)] as PlateEntry['parts'], colors: ['#ffffff'], transform: T, ...(history ? { history } : {}) })
const face = { kind: 'face' as const, objectId: 'box', partIndex: 0, triangle: 3, point: [100, 100, 5] as [number, number, number] }

beforeEach(() => {
  answer.made = null
  set({ plate: [box({ version: 1, base: [boxMesh(40, 20, 5)], steps: [step('s1', 5)] })], selection: 'box', selectedIds: ['box'], subPicks: [face], historyEdit: null })
})
afterEach(() => cleanup())

describe('the made by crumb in the selection pill', () => {
  it('names the step that made the face when the object has it', () => {
    answer.made = { objectId: 'box', index: 0, used: [] }
    mount()
    expect(screen.getByTestId('model-select-made-by').textContent).toBe('made by Pull 5 mm')
  })

  it('says a face the object started with came from the original mesh', () => {
    answer.made = { objectId: 'box', index: -1, used: [] }
    mount()
    expect(screen.getByTestId('model-select-made-by').textContent).toBe('from the original mesh')
  })

  it('shows no crumb when the step is past the end of the history', () => {
    answer.made = { objectId: 'box', index: 1, used: [] }
    expect(() => mount()).not.toThrow()
    expect(screen.queryByTestId('model-select-made-by')).toBeNull()
    expect(screen.getByTestId('model-select-pill')).toBeTruthy()
  })

  it('shows no crumb when the object has no history any more', () => {
    set({ plate: [box()] })
    answer.made = { objectId: 'box', index: 0, used: [] }
    expect(() => mount()).not.toThrow()
    expect(screen.queryByTestId('model-select-made-by')).toBeNull()
  })

  it('shows no crumb when the object is gone', () => {
    set({ plate: [], selection: null, selectedIds: [] })
    answer.made = { objectId: 'box', index: 0, used: [] }
    expect(() => mount()).not.toThrow()
    expect(screen.queryByTestId('model-select-made-by')).toBeNull()
  })
})
