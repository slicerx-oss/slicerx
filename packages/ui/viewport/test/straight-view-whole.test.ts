// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A straight view in the CAD looks (Model and mimir) frames the whole design, whatever is picked, so the view does not
// depend on the last part added or clicked; Isometric still frames the pick, and Slice's straight views frame the bed.
// An empty design frames the whole plate.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vector3, type Material, type PerspectiveCamera } from 'three'

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

describe('the isometric view of an empty design', () => {
  const W = 1440
  const H = 820

  /** A viewport on a W by H canvas showing `objects` on a bed, in the isometric view. */
  function isoOn(bed: typeof BED, objects: ReturnType<typeof cube>[]) {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { value: W })
    Object.defineProperty(canvas, 'clientHeight', { value: H })
    const vp = createViewport(canvas, { quality: 'low', reveal: false, adaptive: false })
    vp.setPlate({ bed, objects })
    vp.view('iso')
    const inner = vp as unknown as { camera: PerspectiveCamera; controls: { target: Vector3 } }
    const camera = inner.camera
    camera.updateMatrixWorld(true)
    /** Where world points land on screen, pixels from the top left: the extent of them all. */
    const extent = (pts: Vector3[]) => {
      const px = pts.map((p) => p.clone().project(camera)).map((p) => ({ x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H }))
      return { x0: Math.min(...px.map((p) => p.x)), x1: Math.max(...px.map((p) => p.x)), y0: Math.min(...px.map((p) => p.y)), y1: Math.max(...px.map((p) => p.y)) }
    }
    return { vp, inner, extent }
  }

  /** The plate's four corners in the world (Y up, bed center at the origin). */
  const corners = (w: number, d: number) => [new Vector3(-w / 2, 0, -d / 2), new Vector3(w / 2, 0, -d / 2), new Vector3(-w / 2, 0, d / 2), new Vector3(w / 2, 0, d / 2)]

  for (const [name, w, d] of [['a 256 by 256 mm bed', 256, 256], ['a 350 by 320 mm bed', 350, 320]] as const) {
    it(`frames the whole plate with room around it on ${name}`, () => {
      const { vp, extent } = isoOn({ widthMm: w, depthMm: d, heightMm: 256 }, [])
      const plate = extent(corners(w, d))
      // every corner on screen with at least a tenth of the view clear at each side, the outline still large
      expect(plate.x0).toBeGreaterThan(0.1 * W)
      expect(plate.x1).toBeLessThan(0.9 * W)
      expect(plate.y0).toBeGreaterThan(0.1 * H)
      expect(plate.y1).toBeLessThan(0.9 * H)
      expect((plate.x1 - plate.x0) / W).toBeGreaterThan(0.6)
      vp.dispose()
    })
  }

  it('frames a part as it always has', () => {
    // a 20 mm part on the 256 mm bed: its own box framed, the pose the isometric view has always given it
    const { vp, inner } = isoOn(BED, [cube('a', 110)])
    const pos = inner.camera.position
    const target = inner.controls.target
    expect(target.toArray().map((v) => +v.toFixed(3))).toEqual([-8, 10.02, -10])
    expect(pos.x).toBeCloseTo(37.894, 3)
    expect(pos.y).toBeCloseTo(39.225, 3)
    expect(pos.z).toBeCloseTo(59.536, 3)
    vp.dispose()
  })
})
