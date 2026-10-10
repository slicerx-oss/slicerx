// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Ctrl (Cmd) and a click add an object to the selection or take it out; the primary stays unless it is taken out.
import type { MeshHandle } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { setTool, toolStore } from '../src/plate/tools'
import { identity } from '../src/plate/transform'
import { set, toggledSelection, type PlateEntry } from '../src/state/store'
import { ObjectTransform } from '../src/workspaces/prepare/object-transform'

describe('toggling an object in the selection', () => {
  it('adds an object, keeping the primary', () => {
    expect(toggledSelection({ selection: 'a', selectedIds: [] }, 'b')).toEqual({ selection: 'a', selectedIds: ['a', 'b'], towerSelected: false })
  })

  it('takes one out, and the last one left becomes the primary when the primary goes', () => {
    expect(toggledSelection({ selection: 'a', selectedIds: ['a', 'b', 'c'] }, 'b')).toEqual({ selection: 'a', selectedIds: ['a', 'c'], towerSelected: false })
    expect(toggledSelection({ selection: 'a', selectedIds: ['a', 'c'] }, 'a')).toEqual({ selection: 'c', selectedIds: ['c'], towerSelected: false })
  })

  it('starts a selection from nothing and ends it at nothing', () => {
    expect(toggledSelection({ selection: null, selectedIds: [] }, 'a')).toEqual({ selection: 'a', selectedIds: ['a'], towerSelected: false })
    expect(toggledSelection({ selection: 'a', selectedIds: ['a'] }, 'a')).toEqual({ selection: null, selectedIds: [], towerSelected: false })
  })
})

describe('the scale panel with several objects', () => {
  function entry(id: string): PlateEntry {
    const p: number[] = []
    for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [0, 5]) p.push(x, y, z)
    const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
    return { id, name: id, handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#ebebe6'], transform: identity() }
  }
  afterEach(() => toolStore.setState({ tool: 'move', rotateSpace: 'world', moveArrows: false }))

  it('says they scale evenly, below the actions, only for several', () => {
    set({ plate: [entry('a'), entry('b')], selection: 'a', selectedIds: ['a'] })
    setTool('scale')
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ObjectTransform)))
    expect(el.querySelector('.tf-note')).toBeNull()
    flushSync(() => set({ selectedIds: ['a', 'b'] }))
    const note = el.querySelector('.tf-note')
    expect(note?.textContent).toMatch(/scale evenly/)
    // it comes after the actions, so the controls above it keep their places
    expect(note?.previousElementSibling?.classList.contains('tf-actions')).toBe(true)
    root.unmount()
  })
})
