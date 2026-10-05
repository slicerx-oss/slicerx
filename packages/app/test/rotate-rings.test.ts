// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { rotateAbout } from '@slicerx/viewport'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { commitTransforms } from '../src/plate/edit'
import { setTool, toolStore } from '../src/plate/tools'
import { identity } from '../src/plate/transform'
import { set, type PlateEntry } from '../src/state/store'
import { ObjectTransform } from '../src/workspaces/prepare/object-transform'

function entry(id: string): PlateEntry {
  const p: number[] = []
  for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [0, 5]) p.push(x, y, z)
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#bd93f9'], transform: identity() }
}

describe('rotate tool panel', () => {
  afterEach(() => toolStore.setState({ tool: 'move', rotateSpace: 'world' }))

  it('switches the rings between bed and object axes, and the fields follow a ring drag', async () => {
    set({ plate: [entry('a')], selection: 'a' })
    setTool('rotate')
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ObjectTransform)))
    const object = [...el.querySelectorAll('[role="radio"], button')].find((b) => b.textContent === 'Object axes') as HTMLElement
    expect(object).toBeTruthy()
    flushSync(() => object.click())
    expect(toolStore.getState().rotateSpace).toBe('local')
    // The viewport reports the turned matrix on release; the rotation fields show it.
    flushSync(() => commitTransforms({ a: rotateAbout(identity(), [0, 0, 2.5], [0, 0, 1], (15 * Math.PI) / 180) }))
    // The field takes the new value in an effect.
    await new Promise((r) => setTimeout(r, 0))
    const z = el.querySelector<HTMLInputElement>('#tf-rotation-z')
    expect(z?.value).toBe('15')
    root.unmount()
  })
})
