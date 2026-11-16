// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An object rebuilt again and again under one id (each step of a design changes its mesh) keeps only what it draws now.
// A rebuild once kept every build before it alive, from the new part's edges back through each old one, so a long
// design session held every old mesh's arrays, the paint drawn on them and the renderer's lists of what it last drew.
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BufferGeometry, Group } from 'three'

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

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

/** Collects twice, a task apart: a WeakRef read in this task keeps its target until the task ends. */
async function collect(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r))
    gc()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BED = { widthMm: 180, depthMm: 180, heightMm: 180 }
/** Triangles in each build: about 2 MB of arrays as sent, more once the view has built its own from them. */
const STRIP = 40_000

/** The ship as one design step leaves it: a strip of triangles whose height follows the step, in new arrays each time. */
function ship(step: number) {
  const positions = new Float32Array((STRIP + 2) * 3)
  for (let i = 0; i < STRIP + 2; i++) positions.set([i * 0.01, i % 2 ? 10 : 0, step + (i % 3)], i * 3)
  const indices = new Uint32Array(STRIP * 3)
  for (let t = 0; t < STRIP; t++) indices.set(t % 2 ? [t, t + 2, t + 1] : [t, t + 1, t + 2], t * 3)
  return { id: 'ship', name: 'Ship', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 50, 0, 1], parts: [{ name: 'Ship', color: '#ff8800', positions, indices }] }
}

describe('an object rebuilt under the same id', () => {
  it('lets each earlier build go: 12 rebuilds keep one group and one geometry, and memory stays flat', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    // jsdom has no 2D canvas
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const vp = createViewport(document.createElement('canvas'), { quality: 'low', reveal: false, adaptive: false })
    const objects = (vp as unknown as { objects: Map<string, { group: Group; parts: { mesh: { geometry: BufferGeometry } }[] }> }).objects
    const groups: WeakRef<Group>[] = []
    const geometries: WeakRef<BufferGeometry>[] = []
    const build = (step: number) => {
      vp.setPlate({ bed: BED, objects: [ship(step)] })
      const entry = objects.get('ship')!
      groups.push(new WeakRef(entry.group))
      geometries.push(new WeakRef(entry.parts[0]!.mesh.geometry))
    }
    const live = <T extends object>(refs: WeakRef<T>[]) => refs.filter((r) => r.deref() !== undefined).length
    const bytes = () => process.memoryUsage().arrayBuffers

    // what one build holds: the arrays as sent and the geometry made from them
    await collect()
    const empty = bytes()
    build(0)
    await collect()
    const start = bytes()
    const perBuild = start - empty
    expect(perBuild).toBeGreaterThan(2_000_000)
    for (let step = 1; step <= 12; step++) build(step)
    await collect()

    expect(live(groups)).toBe(1)
    expect(live(geometries)).toBe(1)
    // a build that stayed would add a whole build's arrays each time: 12 of them, against less than one here
    expect(bytes() - start).toBeLessThan(perBuild)
    vp.dispose()
  })
})
