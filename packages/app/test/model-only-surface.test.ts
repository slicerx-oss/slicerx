// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model shows modeling only: positions from the grid center, no copies, no print looks and no slicing commands in the
// command bar. Slice keeps bed coordinates and all of it. The stored transform is the same in both.
import type { MeshHandle } from '@slicerx/contracts'
import { createElement, type FunctionComponent } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { compose, decompose, modelOrigin } from '../src/plate/transform'
import { listedInMode, setHostSlices } from '../src/state/model-mode'
import { get, set, type PlateEntry } from '../src/state/store'
import { ObjectTransform } from '../src/workspaces/prepare/object-transform'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

/** A 20 x 10 x 5 mm box at `at` on a 256 mm bed. */
function entry(at: [number, number, number]): PlateEntry {
  const p: number[] = []
  for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [0, 5]) p.push(x, y, z)
  const handle = { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id: 'a', name: 'a', handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#bd93f9'], transform: compose({ position: at, rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('the Model surface', () => {
  let el: HTMLDivElement | null = null
  let root: Root | null = null
  const render = () => {
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    flushSync(() => root!.render(createElement(ObjectTransform as FunctionComponent<{ full?: boolean }>, { full: true })))
    return el
  }
  afterEach(() => {
    root?.unmount()
    el?.remove()
    setHostSlices(true)
  })

  it('counts Model positions from the grid center', () => {
    expect(modelOrigin({ widthMm: 256, depthMm: 220 })).toEqual([128, 110, 0])
  })

  it('shows the grid frame in Model, without copies, and stores bed coordinates', () => {
    setHostSlices(false)
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate: [entry([138, 128, 0])], selection: 'a', modelMode: 'design', workspace: 'prepare' })
    const box = render()
    expect(box.querySelector('[data-frame]')?.getAttribute('data-frame')).toBe('grid')
    expect(box.querySelector<HTMLInputElement>('#tf-position-x')?.value).toBe('10')
    expect(box.querySelector<HTMLInputElement>('#tf-position-y')?.value).toBe('0')
    expect(box.querySelector('[aria-label="Instances"]')).toBeNull()
    expect(box.textContent).not.toContain('Fill bed')
    expect(box.textContent).toContain('Drop to ground')
    expect(decompose(get().plate[0]!.transform).position).toEqual([138, 128, 0])
  })

  it('keeps bed coordinates and copies in Slice', () => {
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate: [entry([138, 128, 0])], selection: 'a', modelMode: 'slice', workspace: 'prepare' })
    const box = render()
    expect(box.querySelector('[data-frame]')?.getAttribute('data-frame')).toBe('bed')
    expect(box.querySelector<HTMLInputElement>('#tf-position-x')?.value).toBe('138')
    expect(box.querySelector('[aria-label="Instances"]')).not.toBeNull()
    expect(box.textContent).toContain('Fill bed')
    expect(box.textContent).toContain('Drop to bed')
  })

  it('leaves the slicing commands out of the command bar in Model', () => {
    for (const id of ['slice', 'slice-cancel', 'export-gcode', 'gcode-lines']) {
      expect(listedInMode(id, 'design')).toBe(false)
      expect(listedInMode(id, 'slice')).toBe(true)
    }
    expect(listedInMode('mode-slice', 'design')).toBe(true)
    setHostSlices(false)
    expect(listedInMode('mode-slice', 'design')).toBe(false)
  })
})
