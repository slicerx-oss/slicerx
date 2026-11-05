// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exploded view in a whole viewport: it follows a move and a rebuilt plate, an object parked and brought back
// comes whole, volumes stay with their object, an edit tool or a drag puts the parts back where they print (and says
// so), and every box and drop measures the parts at home, never where the spread draws them.
import { Matrix3, Matrix4, Vector3, type Box3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BED = { widthMm: 180, depthMm: 180, heightMm: 180 }
/** A 10 mm tetrahedron from (x, y, z). */
const part = (x: number, y = 0, z = 0) => ({
  name: `p${x}`,
  color: '#ff8800',
  positions: new Float32Array([x, y, z, x + 10, y, z, x, y + 10, z, x, y, z + 10]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
})
const at = (x: number, y: number, m = new Matrix4()) => new Matrix4().makeTranslation(x, y, 0).multiply(m).toArray()

type Entry = { id: string; group: { matrix: Matrix4 }; parts: { mesh: { position: Vector3 } }[] }
type Inner = { objects: Map<string, Entry>; bedBox(o: Entry): Box3 }

function view() {
  const vp = createViewport(document.createElement('canvas'), { quality: 'low', reveal: false, adaptive: false })
  vi.runAllTimers()
  const inner = vp as unknown as Inner
  const off: string[] = []
  const held: boolean[] = []
  vp.on('explodeoff', (e) => off.push(e.reason))
  vp.on('explodehold', (e) => held.push(e.held))
  return { vp, inner, off, held, entry: (id: string) => inner.objects.get(id)! }
}

/** Part i's drawn offset in the bed's frame: its mesh offset through the object's turn. */
const bedDelta = (e: Entry, i: number) => e.parts[i]!.mesh.position.clone().applyMatrix3(new Matrix3().setFromMatrix4(e.group.matrix))
const home = (e: Entry) => e.parts.every((p) => p.mesh.position.lengthSq() === 0)

describe('the exploded view in the viewport', () => {
  const kit = { id: 'kit', name: 'kit', transform: at(60, 60), parts: [part(0), part(10)] }

  it('follows the object when it is turned (setTransforms) and keeps through a rebuilt plate', () => {
    const { vp, entry } = view()
    vp.setPlate({ bed: BED, objects: [kit] })
    vp.setExplode!({ ids: ['kit'], spread: 100, axis: 'x' })
    expect(bedDelta(entry('kit'), 1).x).toBeCloseTo(6.25)
    // a quarter turn: the parts now line up along the bed's Y, and still spread along the bed's X
    vp.setTransforms({ kit: at(60, 60, new Matrix4().makeRotationZ(Math.PI / 2)) })
    for (let i = 0; i < 2; i++) {
      const d = bedDelta(entry('kit'), i)
      expect(Math.abs(d.y) + Math.abs(d.z), `part ${i}`).toBeCloseTo(0)
      expect(Math.abs(d.x)).toBeCloseTo(6.25)
    }
    // the same arrays again keep the build and the spread; new arrays build it again, spread
    vp.setPlate({ bed: BED, objects: [{ ...kit, transform: at(60, 60) }] })
    expect(vp.exploded!()['kit']).toHaveLength(2)
    vp.setPlate({ bed: BED, objects: [{ ...kit, parts: [part(0), part(10)] }] })
    expect(vp.exploded!()['kit']).toHaveLength(2)
    expect(bedDelta(entry('kit'), 1).x).toBeCloseTo(6.25)
    vp.dispose()
  })

  it('brings an object back whole once it is no longer spread', () => {
    const { vp, entry } = view()
    vp.setPlate({ bed: BED, objects: [kit] })
    vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'radial' })
    const parked = entry('kit')
    vp.setPlate({ bed: BED, objects: [] })
    vp.setExplode!(null)
    vp.setPlate({ bed: BED, objects: [kit] })
    expect(entry('kit')).toBe(parked)
    expect(home(entry('kit'))).toBe(true)
    expect(vp.exploded!()).toEqual({})
    vp.dispose()
  })

  it('leaves volumes with their object', () => {
    const { vp, entry } = view()
    vp.setPlate({ bed: BED, objects: [{ ...kit, parts: [part(0), part(10), part(20)] }] })
    vp.setExplode!({ ids: ['kit'], spread: 100, axis: 'x', parts: { kit: 2 } })
    expect(vp.exploded!()['kit']).toHaveLength(2)
    expect(entry('kit').parts[2]!.mesh.position.lengthSq()).toBe(0)
    vp.dispose()
  })

  it('puts the parts back where they print for an edit tool, and draws no spread until it ends', () => {
    const { vp, entry, off, held } = view()
    vp.setPlate({ bed: BED, objects: [kit] })
    vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
    vp.setTool('brim')
    expect(home(entry('kit'))).toBe(true)
    expect(off).toEqual(['tool'])
    expect(held).toEqual([true])
    expect(vp.explodeHeld?.()).toBe(true)
    vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
    expect(home(entry('kit'))).toBe(true)
    expect(off).toEqual(['tool', 'tool'])
    vp.setTool('select')
    expect(held).toEqual([true, false])
    vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
    expect(home(entry('kit'))).toBe(false)
    // the other edit modes hold it too
    // Model's face and edge filters only say what a click picks, so they leave the spread alone
    vp.setPickFaces?.(true)
    vp.setPickEdges?.(true)
    expect(home(entry('kit'))).toBe(false)
    vp.setPickFaces?.(false)
    vp.setPickEdges?.(false)
    for (const on of [() => vp.setProbeFaces(true), () => vp.setSelectedFaces?.([{ objectId: 'kit', partIndex: 0, triangle: 0 }]), () => vp.setCutPlane({ objectId: 'kit', point: [70, 70, 5], normal: [0, 0, 1], keep: 'both' } as never)]) {
      on()
      expect(home(entry('kit'))).toBe(true)
      vp.setProbeFaces(false)
      vp.setSelectedFaces?.([])
      vp.setCutPlane(null)
      vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
      expect(home(entry('kit'))).toBe(false)
    }
    vp.dispose()
  })

  it('measures boxes and drops with the parts at home', () => {
    const { vp, inner, entry } = view()
    vp.setPlate({ bed: BED, objects: [kit] })
    const before = inner.bedBox(entry('kit')).clone()
    vp.setExplode!({ ids: ['kit'], spread: 100, axis: 'x' })
    const spread = inner.bedBox(entry('kit'))
    expect(spread.min.distanceTo(before.min) + spread.max.distanceTo(before.max)).toBeCloseTo(0)

    // Turned upside down by a drag (the group's matrix written directly, as a drag does) and lifted so the parts sit on
    // the bed: the spread drawn for the old turn points down, and still nothing moves on a drop.
    vp.setExplode!({ ids: ['kit'], spread: 100, axis: 'z' })
    const g = entry('kit').group
    g.matrix.fromArray(new Matrix4().makeTranslation(60, 60, 10).multiply(new Matrix4().makeRotationX(Math.PI)).toArray())
    ;(g as unknown as { matrixWorldNeedsUpdate: boolean }).matrixWorldNeedsUpdate = true
    expect(vp.dropToBed?.()).toEqual({})
    vp.dispose()
  })
})

/** A box from (x, y, z) of size s, with outward triangles. */
const box = (name: string, [x, y, z]: [number, number, number], s = 10) => {
  const v = Array.from({ length: 8 }, (_, i) => [x + (i & 1 ? s : 0), y + (i & 2 ? s : 0), z + (i & 4 ? s : 0)]).flat()
  const t = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { name, color: '#ff8800', positions: new Float32Array(v), indices: new Uint32Array(t) }
}
const stack = { id: 'stack', name: 'stack', transform: at(60, 60), parts: [box('low', [0, 0, 0]), box('high', [0, 0, 10])] }

/** A viewport whose canvas is 800 by 600 at the page corner, so screen points and picks line up. */
function sized() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  Object.defineProperty(HTMLCanvasElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
  const v = view()
  v.vp.setPlate({ bed: BED, objects: [stack] })
  v.vp.view('iso', { animate: false })
  return v
}
/** The middle of the high box's top face, in bed mm, as it prints. */
const highTop = (tx = 60, ty = 60): [number, number, number] => [tx + 5, ty + 5, 20]
const pointer = (type: string, x: number, y: number) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true })
  Object.assign(e, { pointerId: 1, pointerType: 'mouse' })
  return e
}

describe('picks on a spread part', () => {
  it('report where the part prints: point, face and triangle, with the spread still drawn', () => {
    const { vp } = sized()
    const whole = vp.screenOf!(highTop())!
    const before = vp.pickFace(...whole)!
    expect(before.partIndex).toBe(1)
    vp.setPickFaces?.(true)
    vp.setPickEdges?.(true)
    vp.setExplode!({ ids: ['stack'], spread: 100, axis: 'z' })
    const lift = vp.exploded!()['stack']![1]![2]!
    expect(lift).toBeGreaterThan(10)
    // the high box's top where it is drawn now
    const drawnAt = vp.screenOf!([highTop()[0], highTop()[1], 20 + lift])!
    const face = vp.pickFace(...drawnAt)!
    expect(face.partIndex).toBe(1)
    expect(face.normal[2]).toBeCloseTo(1)
    expect(face.point[2]).toBeCloseTo(20, 4)
    expect(face.centerBed).toEqual(before.centerBed)
    const all = vp.pickAll!(...drawnAt)
    expect(all[0]).toMatchObject({ objectId: 'stack', partIndex: 1 })
    expect(all[0]!.point[2]).toBeCloseTo(20, 4)
    const atHome = vp.pickAll!(...whole).find((h) => h.partIndex === 1)
    if (atHome) expect(all[0]!.triangle === atHome.triangle || all[0]!.patch === atHome.patch).toBe(true)
    expect(vp.exploded!()['stack']).toBeDefined()
    vp.dispose()
  })

  it('report where a turned part prints', () => {
    const { vp } = sized()
    vp.setTransforms({ stack: at(60, 60, new Matrix4().makeRotationZ(Math.PI / 2)) })
    vp.setPickFaces?.(true)
    vp.setExplode!({ ids: ['stack'], spread: 100, axis: 'z' })
    const lift = vp.exploded!()['stack']![1]![2]!
    // turned about Z through its corner: the top's middle goes to (60 - 5, 60 + 5)
    const face = vp.pickFace(...vp.screenOf!([55, 65, 20 + lift])!)!
    expect(face.partIndex).toBe(1)
    expect(face.point[0]).toBeCloseTo(55, 3)
    expect(face.point[1]).toBeCloseTo(65, 3)
    expect(face.point[2]).toBeCloseTo(20, 4)
    vp.dispose()
  })
})

describe('when the spread goes back to 0 by itself', () => {
  const kit = { id: 'kit', name: 'kit', transform: at(60, 60), parts: [part(0), part(10)] }
  it('holds for every edit tool and edit mode, and for as long as any of them is on', () => {
    const sources: [string, (v: ReturnType<typeof view>['vp']) => void, (v: ReturnType<typeof view>['vp']) => void][] = [
      ...(['face', 'paint', 'brim', 'probe'] as const).map((t): [string, (v: ReturnType<typeof view>['vp']) => void, (v: ReturnType<typeof view>['vp']) => void] => [t, (v) => v.setTool(t), (v) => v.setTool('select')]),
      ['edge preview', (v) => v.setEdgePreview({ objectId: 'kit', partIndex: 0, add: null, remove: null } as never), (v) => v.setEdgePreview(null)],
      ['picked edge', (v) => v.setPickedEdges?.([{ from: [60, 60, 0], to: [70, 60, 0] }]), (v) => v.setPickedEdges?.([])],
      ['sketch', (v) => v.setSketch({ frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }, paths: [] } as never), (v) => v.setSketch(null)],
    ]
    for (const [name, on, off] of sources) {
      const { vp, entry, held, off: dropped } = view()
      vp.setPlate({ bed: BED, objects: [kit] })
      vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
      on(vp)
      expect(home(entry('kit')), name).toBe(true)
      expect(dropped, name).toEqual(['tool'])
      expect(held, name).toEqual([true])
      off(vp)
      expect(held, name).toEqual([true, false])
      vp.dispose()
    }
    // two at once: the spread waits for the last
    const { vp, entry } = view()
    vp.setPlate({ bed: BED, objects: [kit] })
    vp.setTool('brim')
    vp.setSelectedFaces?.([{ objectId: 'kit', partIndex: 0, triangle: 0 }])
    vp.setTool('select')
    expect(vp.explodeHeld?.()).toBe(true)
    vp.setSelectedFaces?.([])
    expect(vp.explodeHeld?.()).toBe(false)
    vp.setExplode!({ ids: ['kit'], spread: 60, axis: 'z' })
    expect(home(entry('kit'))).toBe(false)
    vp.dispose()
  })

  it('a press on a spread model drops it once the press becomes a drag, and a click picks what it was on', () => {
    const { vp, off, entry } = sized()
    vp.setTool('move')
    vp.setSelection(['stack'])
    vp.setPickFaces?.(true)
    vp.setExplode!({ ids: ['stack'], spread: 100, axis: 'z' })
    const lift = vp.exploded!()['stack']![1]![2]!
    const [x, y] = vp.screenOf!([highTop()[0], highTop()[1], 20 + lift])!
    const canvas = (vp as unknown as { canvas: HTMLCanvasElement }).canvas
    const picks: { partIndex: number | null; point: number[] | null }[] = []
    vp.on('pick', (e) => picks.push(e))
    // a click: no drop, and the pick is the high box's top where it prints
    canvas.dispatchEvent(pointer('pointerdown', x, y))
    canvas.dispatchEvent(pointer('pointermove', x + 2, y + 1))
    expect(off).toEqual([])
    canvas.dispatchEvent(pointer('pointerup', x + 2, y + 1))
    expect(off).toEqual([])
    expect(home(entry('stack'))).toBe(false)
    expect(picks.at(-1)?.partIndex).toBe(1)
    expect(picks.at(-1)?.point?.[2]).toBeCloseTo(20, 4)
    // a drag: past the slop the parts go home first
    canvas.dispatchEvent(pointer('pointerdown', x, y))
    canvas.dispatchEvent(pointer('pointermove', x + 12, y))
    expect(off).toEqual(['drag'])
    expect(home(entry('stack'))).toBe(true)
    canvas.dispatchEvent(pointer('pointerup', x + 12, y))
    vp.dispose()
  })
})

describe('height paint on a spread object', () => {
  it('paints the same triangles as with the parts at home', () => {
    const strokes = (spread: number) => {
      const { vp } = view()
      vp.setPlate({ bed: BED, objects: [stack] })
      if (spread) vp.setExplode!({ ids: ['stack'], spread, axis: 'z' })
      const got: { partIndex: number; edits: { triangle: number }[] }[] = []
      vp.on('paintstroke', (s) => got.push({ partIndex: s.partIndex, edits: s.edits.map((e) => ({ triangle: e.triangle })) }))
      // the high box's band where it prints
      vp.paintHeightRange('stack', [12, 18])
      vp.dispose()
      return got
    }
    const home0 = strokes(0)
    expect(home0.some((s) => s.partIndex === 1 && s.edits.length > 0)).toBe(true)
    expect(strokes(100)).toEqual(home0)
  })
})
