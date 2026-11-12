// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A straight view in the CAD looks (Model and mimir) frames the whole design, whatever is picked, so the view does not
// depend on the last part added or clicked; Isometric still frames the pick, and Slice's straight views frame the bed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Material } from 'three'

/** Stands in for any WebGL object: every property is another stand-in, every call returns one, and it reads as 0. */
function standIn(): unknown {
  const fn = function () {} as unknown as object
  const kept = new Map<PropertyKey, unknown>()
  const p: object = new Proxy(fn, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => 0
      if (k === 'then') return undefined
      if (!kept.has(k)) kept.set(k, standIn())
      return kept.get(k)
    },
    set(_t, k, v) {
      kept.set(k, v)
      return true
    },
    apply: () => p,
    construct: () => p,
  })
  return p
}

vi.mock('three', async (orig) => {
  const three = await orig<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: function WebGLRenderer() {
      return standIn()
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new three.Texture() }
      }
      compileEquirectangularShader() {}
      dispose() {}
    },
    CubeCamera: class extends three.Object3D {
      update() {}
    },
  }
})

const { createViewport } = await import('../src/viewport')

const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
const cube = (id: string, x: number) => ({
  id,
  name: id,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 128, 0, 1],
  parts: [
    {
      name: id,
      color: '#ff8800',
      positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 20]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    },
  ],
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a straight view of a design with a part picked', () => {
  function threeBoxes() {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const vp = createViewport(document.createElement('canvas'), { quality: 'low', reveal: false, adaptive: false })
    // three 20 mm boxes in a row, the last one picked, as after adding three boxes
    vp.setPlate({ bed: BED, objects: [cube('a', 70), cube('b', 110), cube('c', 150)] })
    vp.setSelection(['c'])
    const target = () => (vp as unknown as { controls: { target: { x: number; y: number; z: number } } }).controls.target
    return { vp, target }
  }

  it('frames all three boxes from the top in Model, not the picked one', () => {
    const { vp, target } = threeBoxes()
    vp.setRenderMode('cadColor')
    vp.view('top')
    const top = { ...target() }
    vp.view('iso')
    const iso = { ...target() }
    // the top view aims between the first and the last box, the isometric view at the picked last one
    expect(Math.abs(top.x - iso.x)).toBeGreaterThan(30)
    vp.setSelection([])
    vp.view('top')
    expect(target().x).toBeCloseTo(top.x, 6)
    expect(target().z).toBeCloseTo(top.z, 6)
    vp.dispose()
  })
})
