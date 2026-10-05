// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// UltiMaker S series in heimdall: the print core switch as the slicer writes it and the firmware runs it (the head
// stops at the switching position, the lever runs into the switch bay and along it, the right core lowers or lifts),
// and the head, cores, lever and bay as separate solids that never run into each other.
import { describe, expect, it } from 'vitest'
import { Box3, Vector3, type Mesh, type Object3D } from 'three'
import { changeSequence, poseAt, toolChangerSpec, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig, UM } from '../src/toolhead'

/** The S5 as its shipped profile resolves (packages/profiles/cura/ultimaker.json). */
const s5Cfg = {
  nozzle_diameter: [0.4, 0.4],
  extruder_offset: [[0, 0], [22, 0]],
  toolchange_park_position: [[330, 237], [330, 219]],
  retraction_length: [6.5, 6.5],
  retraction_speed: [45, 45],
  retract_length_toolchange: [16, 12],
  retract_speed_toolchange: [20, 20],
  retract_lift_toolchange: [2, 2],
  z_hop: [2, 2],
  travel_speed: [150],
  travel_speed_z: [10],
  machine_max_acceleration_x: [9000, 9000],
}
const s5 = () => toolChangerSpec('ultimaker-s5', s5Cfg, { widthMm: 330, depthMm: 240, heightMm: 300 }, 2)!
const s3 = () => toolChangerSpec('ultimaker-s3', { ...s5Cfg, toolchange_park_position: ['180x180', '180x180'] }, { widthMm: 230, depthMm: 190, heightMm: 200 }, 2)!

const shown = (o: Object3D, stop: Object3D): boolean => {
  for (let p: Object3D | null = o; p && p !== stop; p = p.parent) if (!p.visible) return false
  return true
}
function boxes(g: Object3D, stop: Object3D): { name: string; box: Box3; parent: Object3D | null }[] {
  const out: { name: string; box: Box3; parent: Object3D | null }[] = []
  g.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || !m.name || m.name === 'shadow' || !shown(m, stop)) return
    out.push({ name: m.name, box: new Box3().setFromObject(m), parent: m.parent })
  })
  return out
}
function depth(a: Box3, b: Box3): number {
  return Math.min(Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y), Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z))
}
const world = (o: Object3D) => o.getWorldPosition(new Vector3())
const cores = (rig: ToolheadRig) => {
  const out: Object3D[] = []
  rig.root.getObjectByName('nozzle')!.traverse((o) => void (o.name === 'print core' && out.push(o)))
  return out as [Object3D, Object3D]
}

/** Every overlap between two parts of the head (other than parts of one print core), and between the head and the bay. */
function overlaps(rig: ToolheadRig): { inside: number; bay: number; at: string } {
  rig.root.updateMatrixWorld(true)
  const head = boxes(rig.root.getObjectByName('nozzle')!, rig.root)
  const fixed = boxes(rig.root.getObjectByName('changer')!, rig.root)
  let inside = -Infinity
  let bay = -Infinity
  let at = ''
  for (let i = 0; i < head.length; i++)
    for (let j = i + 1; j < head.length; j++) {
      const a = head[i]!
      const b = head[j]!
      // A print core and the lever are each one assembly; only different assemblies must stay apart.
      if (a.parent === b.parent && (a.parent?.name === 'print core' || a.parent?.name === 'lever')) continue
      const d = depth(a.box, b.box)
      if (d > inside) {
        inside = d
        at = `${a.name} into ${b.name}`
      }
    }
  for (const a of head)
    for (const b of fixed) {
      const d = depth(a.box, b.box)
      if (d > bay) {
        bay = d
        if (d > 0.01) at = `${a.name} into ${b.name}`
      }
    }
  return { inside, bay, at }
}

describe('UltiMaker S print core switch', () => {
  it('follows the slicer and the firmware: retract, to the switching position, lift, into the bay, along it, out, heat, back', () => {
    const spec = s5()
    expect(spec.kind).toBe('lift-switch')
    expect(spec.extruderOf).toEqual([0, 1])
    expect(spec.liftMm).toBe(2)
    const at: V3 = [150, 120, 0.2]
    const seq = changeSequence(spec, 0, 1, at, [160, 125, 0.2], 4)
    expect(seq.phases.map((p) => p.name)).toEqual(['retract', 'to switch', 'lift', 'into bay', 'switch', 'out of bay', 'heat', 'return', 'lower'])
    // Retraction: 6.5 mm at 45 mm/s, the other 9.5 mm of the 16 mm switch length at 20 mm/s.
    expect(seq.phases[0]!.dwell).toBeCloseTo(6.5 / 45 + 9.5 / 20, 9)
    // The head is written as the left nozzle: it stops at Cura's switching position for the left core, lifts 2 mm,
    // runs along the bay to the right core's position and backs out there.
    expect(seq.phases[1]!.to).toEqual([330, 237, 0.2])
    expect(seq.phases[2]!.to).toEqual([330, 237, 2.2])
    // Along the bay the firmware applies the right core's Z offset: the head stands 1.5 mm higher after.
    expect(seq.phases[4]!.to[2]).toBeCloseTo(3.7, 9)
    expect(seq.phases[4]!.to.slice(0, 2)).toEqual([340, 219])
    expect(seq.phases[5]!.to.slice(0, 2)).toEqual([330, 219])
    // The right core prints there: the head ends 22 mm left of the next move and 1.5 mm higher.
    const end = poseAt(seq, seq.duration)
    expect([end.x, end.y, end.z]).toEqual([138, 125, 1.7])
    expect(end.lift).toBe(1)
    expect(poseAt(seq, 0).lift).toBe(0)
  })

  it('switches back the other way, and on the S3 runs from its switching position to a bay at the back right', () => {
    const back = changeSequence(s5(), 1, 0, [150, 120, 5], [150, 120, 5], 0)
    expect(back.phases[1]!.to).toEqual([330, 219, 6.5])
    expect(back.phases[4]!.to.slice(0, 2)).toEqual([340, 237])
    const spec = s3()
    // Cura gives one switching position; the bay sits where the S5's does on its frame, at the bed's right edge.
    expect(spec.lift!.park).toEqual([[180, 180], [180, 180]])
    expect(spec.lift!.bayAt).toEqual([[230, 187], [230, 169]])
    const seq = changeSequence(spec, 0, 1, [100, 100, 0.2], [110, 100, 0.2], 0)
    expect(seq.phases.map((p) => p.name)).toEqual(['retract', 'to switch', 'lift', 'to bay', 'into bay', 'switch', 'out of bay', 'heat', 'return', 'lower'])
    expect(seq.phases[1]!.to.slice(0, 2)).toEqual([180, 180])
    expect(seq.phases[3]!.to.slice(0, 2)).toEqual([230, 187])
    expect(seq.phases[5]!.to.slice(0, 2)).toEqual([240, 169])
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    expect(rig.root.getObjectByName('switch bay')).toBeDefined()
  })

  it('puts the printing core at the move: the right core lowered 1.5 mm under the left, or lifted 1.5 mm over it', () => {
    const rig = new ToolheadRig()
    rig.setSpec(s5())
    rig.place(100, 100, 10, 0, null, null)
    rig.root.updateMatrixWorld(true)
    let [l, r] = cores(rig)
    expect(world(l).toArray()).toEqual([100, 100, 10.05].map((v) => expect.closeTo(v, 9)))
    expect(world(r).x).toBeCloseTo(122)
    expect(world(r).z).toBeCloseTo(11.55)
    rig.place(100, 100, 10, 1, null, null)
    rig.root.updateMatrixWorld(true)
    ;[l, r] = cores(rig)
    expect(world(r).x).toBeCloseTo(100)
    expect(world(r).z).toBeCloseTo(10.05)
    expect(world(l).x).toBeCloseTo(78)
    expect(world(l).z).toBeCloseTo(11.55)
  })

  it.each([['S5', s5], ['S3', s3]] as const)('%s: is separate solids that only touch, at rest on either core and through whole switches, the bay included', (_, make) => {
    const spec = make()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.setColors(['#ff0000', '#00ff00'])
    rig.visible = true
    for (const tool of [0, 1]) {
      rig.place(165, 120, 10, tool, null, null)
      const o = overlaps(rig)
      expect(o.inside, `at rest on ${tool}: ${o.at}`).toBeLessThanOrEqual(0.01)
    }
    for (const [from, to] of [[0, 1], [1, 0]] as const) {
      const seq = changeSequence(spec, from, to, [165, 120, 12], [175, 120, 12], 3)
      for (let t = 0; t <= seq.duration; t += seq.duration / 1200) {
        const p = poseAt(seq, t)
        rig.place(p.x, p.y, p.z, to, p, p.slots)
        const o = overlaps(rig)
        expect(o.inside, `${p.phase} at ${t.toFixed(2)} s: ${o.at}`).toBeLessThanOrEqual(0.01)
        expect(o.bay, `${p.phase} at ${t.toFixed(2)} s: ${o.at}`).toBeLessThanOrEqual(0.01)
      }
    }
  })

  it('keeps the lever pin in the bay slot while the head runs along it, and the right core moves all the way', () => {
    const spec = s5()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    const seq = changeSequence(spec, 0, 1, [165, 120, 12], [175, 120, 12], 3)
    const sw = seq.phases.find((p) => p.name === 'switch')!
    const pin = () => world(rig.root.getObjectByName('lever pin')!)
    const heights: number[] = []
    let y0: number | null = null
    for (let f = 0.01; f < 1; f += 0.07) {
      const p = poseAt(seq, sw.t0 + sw.move * f)
      rig.place(p.x, p.y, p.z, 1, p, p.slots)
      rig.root.updateMatrixWorld(true)
      y0 ??= pin().y
      expect(pin().y).toBeCloseTo(y0, 6)
      const [, r] = cores(rig)
      heights.push(world(r).z - (p.z + 0.05))
    }
    for (let i = 1; i < heights.length; i++) expect(heights[i]!).toBeLessThanOrEqual(heights[i - 1]! + 1e-9)
    expect(heights[0]!).toBeGreaterThan(1.3)
    expect(heights[heights.length - 1]!).toBeLessThan(-1.3)
    expect(y0).toBeCloseTo((237 + 219) / 2 + UM.lever.y, 6)
  })

  it('never moves faster than the printer allows', () => {
    const spec: ToolChangerSpec = s5()
    const seq = changeSequence(spec, 0, 1, [20, 20, 0.2], [300, 200, 0.2], 2)
    let prev = poseAt(seq, 0)
    const dt = 1 / 240
    for (let t = dt; t <= seq.duration; t += dt) {
      const p = poseAt(seq, t)
      expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) / dt).toBeLessThanOrEqual(spec.travel.speed * 1.02)
      prev = p
    }
  })
})
