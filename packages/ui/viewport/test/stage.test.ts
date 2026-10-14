// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The environment bake reads its cube back before the stage's first frame and releases the target at once, so a stage
// torn down early (a reload, a remount) has nothing of it left to release.
import { describe, expect, it, vi } from 'vitest'
import type { Mesh, WebGLRenderTarget, WebGLRenderer } from 'three'

/** Stands in for three's WebGLRenderer bookkeeping: a target the renderer has forgotten throws on dispose, as in deallocateRenderTarget. */
class FakeRenderer {
  props = new Map<object, { framebuffers: number[] }>()
  released = 0
  reads: number[] = []
  failRead = false
  coordinateSystem = 2000
  readRenderTargetPixels(rt: WebGLRenderTarget, _x: number, _y: number, _w: number, _h: number, _out: Uint16Array, face: number): void {
    if (!this.props.has(rt)) throw new Error('read back of a released target')
    if (this.failRead) throw new Error('read back refused')
    this.reads.push(face)
  }
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

const { Stage, LIFT_MM, FLOOR_ORDER } = await import('../src/stage')

function make(failRead = false) {
  current = new FakeRenderer()
  current.failRead = failRead
  const stage = new Stage(current as unknown as WebGLRenderer, true)
  return { stage, r: current }
}

describe('stage environment bake', () => {
  it('reads all six faces before the first frame and releases the cube target once', () => {
    const { stage, r } = make()
    expect(r.reads).toEqual([0, 1, 2, 3, 4, 5])
    expect(stage.envSH).toHaveLength(9)
    expect(r.released).toBe(1)
    expect(r.props.size).toBe(0)
  })

  it('a refused read back leaves the flat ambient light and still releases the target', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { stage, r } = make(true)
    expect(stage.envSH).toBeNull()
    expect(r.released).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('has nothing of the bake to release when the stage and renderer go away', () => {
    const { stage, r } = make()
    // Viewport.dispose: the stage first, then the renderer.
    stage.dispose()
    r.dispose()
    stage.dispose()
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

describe('a bed change', () => {
  const materials = (stage: InstanceType<typeof Stage>) => {
    const out = new Set<{ addEventListener(t: 'dispose', f: () => void): void }>()
    stage.scene.traverse((o) => {
      const m = (o as Mesh).material
      if (m) for (const x of Array.isArray(m) ? m : [m]) out.add(x)
    })
    return [...out]
  }

  it('keeps the old materials until the next frame, so their shader programs carry over to the new ones', () => {
    const { stage } = make()
    stage.setExcludedAreas([[[0, 0], [18, 0], [18, 28], [0, 28]]])
    const old = materials(stage)
    let released = 0
    for (const m of old) m.addEventListener('dispose', () => released++)
    stage.setBed({ widthMm: 300, depthMm: 300, heightMm: 300 })
    expect(materials(stage).some((m) => old.includes(m))).toBe(false)
    expect(released).toBe(0)
    stage.releaseRetired()
    expect(released).toBe(old.length)
    stage.dispose()
  })

  it('keeps the contact bake materials and bakes again for the new plane', () => {
    const { stage } = make()
    const contact = () => (stage as unknown as { contact: { mat: object; blur: object; rt: object } }).contact
    const before = contact()
    const baked = vi.spyOn(stage, 'bakeContact').mockImplementation(() => undefined)
    stage.setBed({ widthMm: 300, depthMm: 300, heightMm: 300 })
    expect(contact().mat).toBe(before.mat)
    expect(contact().blur).toBe(before.blur)
    expect(contact().rt).toBe(before.rt)
    stage.bakePendingContact()
    expect(baked).toHaveBeenCalledTimes(1)
    stage.dispose()
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

describe('plate reveal uniform', () => {
  const plateMaterial = (stage: InstanceType<typeof Stage>) => {
    let found: { uniforms: { reveal?: { value: { x: number; y: number; z: number } } }; fragmentShader: string } | null = null
    stage.scene.traverse((o) => {
      const m = (o as Mesh).material as unknown as { uniforms?: { reveal?: unknown }; fragmentShader?: string } | undefined
      if (m?.uniforms?.reveal) found = m as never
    })
    return found!
  }

  it('starts settled and keeps its place when the theme rebuilds the plate', async () => {
    const { stage } = make()
    const m0 = plateMaterial(stage)
    expect(m0.fragmentShader).toContain('uniform vec3 reveal')
    expect(m0.uniforms.reveal!.value).toMatchObject({ x: 1, y: 1e9, z: 0 })
    stage.setReveal(0.5, 12, 0.3)
    const { SCENE } = await import('../src/palette')
    stage.setSceneColors({ ...SCENE, selection: '#ff79c6' })
    const m1 = plateMaterial(stage)
    expect(m1).not.toBe(m0)
    expect(m1.uniforms.reveal!.value).toMatchObject({ x: 0.5, y: 12, z: 0.3 })
  })
})
