// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate toolbar offers the brim ears tool for every brim type that prints placed ears: painted, and mouse ears
// (which use an object's ears where it has some and sharp corners otherwise). Other types hide it and drop the tool.
import { cleanup, render, screen } from '@testing-library/react'
import type { LayoutSpec } from '@slicerx/contracts'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brimUsesEars } from '../src/plate/brim-ears'
import { toolStore } from '../src/plate/tools'
import { set } from '../src/state/store'
import { PlateToolbar } from '../src/workspaces/prepare/plate-toolbar'
import { BrimEarsPanel } from '../src/workspaces/prepare/brim-ears-panel'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { MeshHandle } from '@slicerx/contracts'
import type { PlateEntry } from '../src/state/store'

const toolbar = () => render(createElement(PlateToolbar, { layout: { toolbar: 'top' } as unknown as LayoutSpec }))

beforeEach(() => toolStore.setState({ tool: 'move' }))
afterEach(() => cleanup())

describe('brim ears tool', () => {
  it('is used by painted and mouse ears only', () => {
    expect(brimUsesEars('painted')).toBe(true)
    expect(brimUsesEars('brim_ears')).toBe(true)
    for (const t of ['no_brim', 'auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', '', undefined]) expect(brimUsesEars(t)).toBe(false)
  })

  it.each(['painted', 'brim_ears'])('shows in the toolbar with brim type %s', (brim_type) => {
    set({ overrides: { brim_type } })
    toolbar()
    expect(screen.getByRole('button', { name: 'Brim ears' })).toBeTruthy()
  })

  it.each(['no_brim', 'auto_brim', 'outer_only'])('is hidden with brim type %s', (brim_type) => {
    set({ overrides: { brim_type } })
    toolbar()
    expect(screen.queryByRole('button', { name: 'Brim ears' })).toBeNull()
  })

  it('stays open when switching from painted to mouse ears, and closes when the brim stops using ears', () => {
    set({ overrides: { brim_type: 'painted' } })
    toolStore.setState({ tool: 'brim' })
    toolbar()
    act(() => set({ overrides: { brim_type: 'brim_ears' } }))
    expect(toolStore.getState().tool).toBe('brim')
    act(() => set({ overrides: { brim_type: 'outer_only' } }))
    expect(toolStore.getState().tool).toBe('move')
    expect(screen.queryByRole('button', { name: 'Brim ears' })).toBeNull()
  })

  it('says sharp corners get ears under mouse ears while an object has none of its own', () => {
    const box: PlateEntry = {
      id: 'body', name: 'Box', handle: { id: 'body', hash: 'body', name: 'body', triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle,
      parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'],
      transform: compose({ position: [50, 60, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    }
    set({ plate: [box], selection: 'body', selectedIds: ['body'], objectSettings: {}, overrides: { brim_type: 'brim_ears' } })
    render(createElement(BrimEarsPanel))
    expect(screen.getByTestId('brim-ear-count').textContent).toBe('No ears yet. Its sharp corners get ears until you add one.')
    act(() => set({ overrides: { brim_type: 'painted' } }))
    expect(screen.getByTestId('brim-ear-count').textContent).toBe('No ears yet.')
  })
})
