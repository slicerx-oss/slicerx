// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A model added beside the others fades in over its own frames. The loop keeps running for the whole fade, with
// ambient occlusion off and nothing else asking for a frame, so the model does not stop at its first, see-through one.
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

/** Frames asked for and not drawn yet, run by hand at the clock the test sets. */
let frames: FrameRequestCallback[] = []
let clock = 0
/** viewport.ts's FADE_IN_MS, and a frame at 60 Hz. */
const FADE_IN_MS = 220
const FRAME_MS = 16

function stepFrame(ms = FRAME_MS): boolean {
  clock += ms
  const due = frames
  frames = []
  for (const f of due) f(clock)
  return frames.length > 0
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  frames = []
})

const BED = { widthMm: 180, depthMm: 180, heightMm: 180 }
const cube = (id: string, x: number) => ({
  id,
  name: id,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 50, 0, 1],
  parts: [
    {
      name: id,
      color: '#ff8800',
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    },
  ],
})

describe('a model added to the plate', () => {
  it('fades all the way in with ambient occlusion off and nothing else asking for a frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    // jsdom has no 2D canvas
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const canvas = document.createElement('canvas')
    // low quality draws without ambient occlusion
    const vp = createViewport(canvas, { quality: 'low', reveal: false, adaptive: false })
    // the environment bake runs in tasks of its own
    vi.runAllTimers()
    // the same arrays again keep what was built for it, so only the new model is added
    const a = cube('a', 20)
    vp.setPlate({ bed: BED, objects: [a] })
    for (let i = 0; i < 100 && stepFrame(); i++) vi.runAllTimers()
    expect(frames).toEqual([])

    vp.setPlate({ bed: BED, objects: [a, cube('b', 80)] })
    const parts = (vp as unknown as { objects: Map<string, { parts: { mesh: { material: Material } }[] }> }).objects.get('b')!.parts
    const opacity = () => Math.min(...parts.map((p) => p.mesh.material.opacity))
    expect(opacity()).toBe(0)
    // the fade runs FADE_IN_MS from its first frame: one frame past that it is whole
    for (let t = 0; t <= FADE_IN_MS + FRAME_MS; t += FRAME_MS) stepFrame(FRAME_MS)
    expect(opacity()).toBe(1)
    // and the loop rests again once its shared materials are back on screen
    for (let i = 0; i < 5 && stepFrame(); i++);
    expect(frames).toEqual([])
    vp.dispose()
  })
})
