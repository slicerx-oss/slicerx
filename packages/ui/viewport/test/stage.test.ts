// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The environment bake outlives a stage that is torn down early (a reload, a remount): the cube target it reads must
// be released once, while the renderer still knows it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mesh, WebGLRenderTarget, WebGLRenderer } from 'three'

/** Stands in for three's WebGLRenderer bookkeeping: a target the renderer has forgotten throws on dispose, as in deallocateRenderTarget. */
class FakeRenderer {
  props = new Map<object, { framebuffers: number[] }>()
  released = 0
  shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false }
  allocate(rt: WebGLRenderTarget): void {
    if (this.props.has(rt)) return
    this.props.set(rt, { framebuffers: [1, 2, 3, 4, 5, 6] })
    const onDispose = (): void => {
      rt.removeEventListener('dispose', onDispose)
      const p = (this.props.get(rt) ?? {}) as { framebuffers?: number[] }
      // three.js reads __webglFramebuffer[i] here without a check.
      if (!p.framebuffers) throw new TypeError("undefined is not an object (evaluating 'renderTargetProperties.__webglFramebuffer[i]')")
      this.props.delete(rt)
      this.released++
    }
    rt.addEventListener('dispose', onDispose)
  }
  dispose(): void {
    this.props = new Map()
  }
}

let current: FakeRenderer
const bake: { resolve: (() => void) | null } = { resolve: null }
const envBakes = vi.hoisted(() => [] as unknown[][])

vi.mock('three', async (orig) => {
  const three = await orig<typeof import('three')>()
  return {
    ...three,
    PMREMGenerator: class {
      fromScene(...args: unknown[]) {
        envBakes.push(args)
        return { texture: new three.Texture() }
      }
      dispose() {}
    },
    CubeCamera: class {
      constructor(
        _near: number,
        _far: number,
        private rt: WebGLRenderTarget,
      ) {}
      update() {
        current.allocate(this.rt)
      }
    },
  }
})

vi.mock('three/addons/lights/LightProbeGenerator.js', async () => {
  const { SphericalHarmonics3 } = await import('three')
  return {
    LightProbeGenerator: {
      fromCubeRenderTarget: () =>
        new Promise((resolve) => {
          bake.resolve = () => resolve({ sh: new SphericalHarmonics3() })
        }),
    },
  }
})

const { Stage, StageDisposedError, LIFT_MM, FLOOR_ORDER } = await import('../src/stage')

function make() {
  current = new FakeRenderer()
  const stage = new Stage(current as unknown as WebGLRenderer, true)
  const settled = stage.envSH.then(
    (sh) => ({ ok: true as const, sh }),
    (e: unknown) => ({ ok: false as const, e }),
  )
  return { stage, settled, r: current }
}

afterEach(() => {
  bake.resolve = null
})

describe('stage environment bake', () => {
  it('releases the cube target once when the bake finishes', async () => {
    const { settled, r } = make()
    bake.resolve?.()
    const out = await settled
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.sh).toHaveLength(9)
    expect(r.released).toBe(1)
    expect(r.props.size).toBe(0)
  })

  it('survives the stage and renderer going away before the bake ends', async () => {
    const { stage, settled, r } = make()
    // Viewport.dispose: the stage first, then the renderer, both before the async read back is done.
    stage.dispose()
    r.dispose()
    bake.resolve?.()
    const out = await settled
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.e).toBeInstanceOf(StageDisposedError)
    // Released by the stage while the renderer was alive, and not touched again after it was disposed.
    expect(r.released).toBe(1)
  })

  it('does not release twice when disposed twice', async () => {
    const { stage, settled, r } = make()
    stage.dispose()
    stage.dispose()
    bake.resolve?.()
    await settled
    expect(r.released).toBe(1)
  })
})

describe('first frame cost', () => {
  it('prefilters a smaller environment cube on a weak GPU', () => {
    envBakes.length = 0
    current = new FakeRenderer()
    new Stage(current as unknown as WebGLRenderer, true)
    new Stage(current as unknown as WebGLRenderer, false)
    expect(envBakes.map((a) => (a[4] as { size?: number } | undefined)?.size)).toEqual([128, 256])
  })

  it('bakes the contact shadow once for any number of moves before a frame', () => {
    const { stage } = make()
    const baked = vi.spyOn(stage, 'bakeContact').mockImplementation(() => undefined)
    stage.bakePendingContact()
    expect(baked).not.toHaveBeenCalled()
    stage.requestContact()
    stage.requestContact()
    stage.requestContact()
    stage.bakePendingContact()
    stage.bakePendingContact()
    expect(baked).toHaveBeenCalledTimes(1)
    stage.requestContact()
    stage.bakePendingContact()
    expect(baked).toHaveBeenCalledTimes(2)
  })
})

describe('excluded bed areas', () => {
  const find = (stage: InstanceType<typeof Stage>) => {
    const out: Mesh[] = []
    stage.scene.traverse((o) => {
      if (o.name === 'excluded-area') out.push(o as Mesh)
    })
    return out
  }

  it('hatches each area where the profile puts it, and keeps it through a bed change', () => {
    const { stage } = make()
    // The P1P's corner by the purge chute: 18 by 28 mm at the front left.
    stage.setExcludedAreas([[[0, 0], [18, 0], [18, 28], [0, 28]]])
    const [area] = find(stage)
    expect(area).toBeDefined()
    area!.geometry.computeBoundingBox()
    const box = area!.geometry.boundingBox!
    // Bed frame to scene: x - W / 2 and D / 2 - y on a 256 mm bed.
    expect([box.min.x, box.max.x]).toEqual([-128, -110])
    expect([box.min.z, box.max.z]).toEqual([100, 128])
    stage.setBed({ widthMm: 300, depthMm: 300, heightMm: 300 })
    const [moved] = find(stage)
    moved!.geometry.computeBoundingBox()
    expect(moved!.geometry.boundingBox!.min.x).toBe(-150)
    stage.setExcludedAreas([])
    expect(find(stage)).toHaveLength(0)
    stage.dispose()
  })
})

describe('the floor under the print', () => {
  it('keeps every overlay well below the first layer, ordered by render order, never by a hair of height', () => {
    const { stage } = make()
    stage.setNozzleZones([{ id: 'left', label: 'Left nozzle only', color: '#58a6ff', polygon: [[0, 0], [25, 0], [25, 320], [0, 320]] }])
    stage.setExcludedAreas([[[300, 0], [330, 0], [330, 30], [300, 30]]])
    const decor = (stage as unknown as { decor: Mesh['parent'] }).decor!
    decor.updateMatrixWorld(true)
    const seen: { kind: string; order: number }[] = []
    decor.traverse((o) => {
      const m = (o as Mesh).material as { transparent?: boolean; depthWrite?: boolean; polygonOffset?: boolean; polygonOffsetFactor?: number } | undefined
      if (!m || o.type === 'Sprite') return
      const geo = (o as Mesh).geometry
      geo.computeBoundingBox()
      const top = geo.boundingBox!.clone().applyMatrix4(o.matrixWorld).max.y
      // The first layer's beads start at LIFT_MM: nothing on the floor comes within 0.015 mm of them.
      expect(top).toBeLessThanOrEqual(LIFT_MM - 0.015)
      expect(m.transparent).toBe(true)
      expect(m.depthWrite).toBe(false)
      if (o.type === 'Mesh') {
        // Pushed back in depth, so a bead at the same depth always draws over the floor.
        expect(m.polygonOffset).toBe(true)
        expect(m.polygonOffsetFactor).toBeGreaterThan(0)
      }
      seen.push({ kind: o.type, order: o.renderOrder })
    })
    expect(seen.length).toBeGreaterThanOrEqual(5)
    // The plate draws first, then the fills, then their outlines on top.
    expect(FLOOR_ORDER.plate).toBeLessThan(FLOOR_ORDER.fill)
    expect(FLOOR_ORDER.fill).toBeLessThan(FLOOR_ORDER.line)
    for (const s of seen.filter((x) => x.kind === 'Line')) expect(s.order).toBe(FLOOR_ORDER.line)
  })
})
