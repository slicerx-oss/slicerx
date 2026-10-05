// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toolhead, rack and dock meshes: parked tools sit where the sequence parks them, and through a whole
// change no part of the moving head enters the rack or dock (or the other way round).
import { describe, expect, it } from 'vitest'
import { Box3, Vector3, type Mesh, type Object3D } from 'three'
import { SPARE, changeSequence, poseAt, toolChangerSpec, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'
import { HEAD_MODELS, headFor } from '../src/heads'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const h2d = () =>
  toolChangerSpec(
    'bambu-h2d',
    { nozzle_diameter: ['0.4', '0.4'], filament_map: ['1', '2'], machine_switch_extruder_time: '5.6', machine_load_filament_time: '26', machine_unload_filament_time: '26', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
    { widthMm: 350, depthMm: 320, heightMm: 325 },
    2,
  )!
const h2c = (tools = 6) =>
  toolChangerSpec(
    'bambu-h2c',
    { nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'], machine_switch_extruder_time: '5', machine_load_filament_time: '15', machine_unload_filament_time: '15', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
    { widthMm: 330, depthMm: 320, heightMm: 325 },
    tools,
  )!
const u1 = () =>
  toolChangerSpec(
    'snapmaker-u1',
    { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350', machine_max_acceleration_travel: ['20000'] },
    { widthMm: 270, depthMm: 270, heightMm: 270 },
    4,
  )!

const xl = () =>
  toolChangerSpec(
    'prusa-xl-5-toolhead',
    { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4', '0.4'], travel_speed: '400', machine_max_acceleration_travel: ['5000'] },
    { widthMm: 360, depthMm: 360, heightMm: 360 },
    5,
  )!

const s5 = () =>
  toolChangerSpec(
    'ultimaker-s5',
    { nozzle_diameter: [0.4, 0.4], extruder_offset: [[0, 0], [22, 0]], toolchange_park_position: [[330, 237], [330, 219]], retract_lift_toolchange: [2, 2], travel_speed: [150] },
    { widthMm: 330, depthMm: 240, heightMm: 300 },
    2,
  )!

const shown = (o: Object3D, stop: Object3D): boolean => {
  for (let p: Object3D | null = o; p && p !== stop; p = p.parent) if (!p.visible) return false
  return true
}

/** World boxes of the visible solid parts under `g` (the shadow, the ring and the tip are decals, not solids). */
function boxes(g: Object3D, stop: Object3D): { name: string; box: Box3; parent: Object3D | null }[] {
  const out: { name: string; box: Box3; parent: Object3D | null }[] = []
  g.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || !m.name || m.name === 'shadow' || !shown(m, stop)) return
    out.push({ name: m.name, box: new Box3().setFromObject(m), parent: m.parent })
  })
  return out
}

/** How far two boxes overlap on their least overlapping axis; 0 or less means they at most touch. */
function depth(a: Box3, b: Box3): number {
  return Math.min(Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y), Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z))
}

/** Plays a change on the rig and returns the worst overlap between head and rack or dock, and where it happened. */
function sweep(spec: ToolChangerSpec, from: number, to: number, history: [number, number][] = []) {
  const rig = new ToolheadRig()
  rig.setSpec(spec)
  rig.setColors(['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'])
  rig.visible = true
  const at: V3 = [spec.bed.widthMm / 2, spec.bed.depthMm / 2, 12]
  const seq = changeSequence(spec, from, to, at, [at[0] + 10, at[1], 12], 20, history)
  const head = rig.root.getObjectByName('nozzle')!
  const fixed = rig.root.getObjectByName('changer')!
  let worst = { depth: -Infinity, at: '' }
  for (let t = 0; t <= seq.duration; t += seq.duration / 1500) {
    const p = poseAt(seq, t)
    rig.place(p.x, p.y, p.z, to, p, p.slots)
    rig.root.updateMatrixWorld(true)
    const hb = boxes(head, rig.root)
    const fb = boxes(fixed, rig.root)
    for (const a of hb)
      for (const b of fb) {
        const d = depth(a.box, b.box)
        if (d > worst.depth) worst = { depth: d, at: `${p.phase} at ${t.toFixed(2)} s: head ${a.name} into ${b.name}` }
      }
  }
  return { worst, seq, rig }
}

const worldOf = (o: Object3D) => o.getWorldPosition(new Vector3())
const hotendsOf = (o: Object3D) => {
  const out: Object3D[] = []
  o.traverse((c) => void (c.name === 'hotend' && out.push(c)))
  return out
}

describe('ToolheadRig geometry', () => {
  it('H2C: the parked hotends stand in their rack positions, on the forks, without touching each other', () => {
    const spec = h2c()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.place(100, 100, 10, 0, null, [1, 2, 3, 4, 5, -1])
    rig.root.updateMatrixWorld(true)
    const rack = rig.root.getObjectByName('rack')!
    const hotends = rack.children.filter((c) => c.name === 'hotend')
    expect(hotends).toHaveLength(6)
    for (const h of hotends) {
      const k = h.userData.slot as number
      const p = worldOf(h)
      expect(p.x).toBeCloseTo(spec.rack!.x)
      expect(p.y).toBeCloseTo(spec.rack!.ys[k % 3]!)
      expect(p.z).toBeCloseTo(10.05 + Math.floor(k / 3) * spec.rack!.rowRise)
    }
    // Inside the rack, parts only touch: hotends rest on their forks, forks meet the shelf, the shelf the plate.
    const parts = boxes(rack, rig.root)
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i]!
        const b = parts[j]!
        // The parts of one hotend are one assembly; only different assemblies must stay apart.
        if (a.parent === b.parent && a.parent !== rack) continue
        expect(depth(a.box, b.box), `${a.name} into ${b.name}`).toBeLessThanOrEqual(0.01)
      }
  })

  it('H2C: parking and picking from both rows keeps the head clear of the rack, and the bay meets the slot exactly', () => {
    const spec = h2c()
    // Tool 0 in the head parks in slot 5 (upper row), then tool 1 comes from slot 0 (lower row): the rack moves both ways.
    const history: [number, number][] = []
    const park = sweep(spec, 0, 1, history)
    expect(park.worst.depth, park.worst.at).toBeLessThanOrEqual(0.01)
    const later = sweep(spec, 2, 5, [[0, 1], [1, 2]])
    expect(later.worst.depth, later.worst.at).toBeLessThanOrEqual(0.01)
    expect(later.seq.rowBefore).not.toBe(later.seq.rowAfter)
    // At the end of 'dock' the carried hotend is exactly where the parked one appears a moment later.
    const { seq, rig } = park
    const dock = seq.phases.find((p) => p.name === 'dock')!
    const p = poseAt(seq, dock.t0 + dock.move)
    rig.place(p.x, p.y, p.z, 1, p, p.slots)
    rig.root.updateMatrixWorld(true)
    const head = rig.root.getObjectByName('nozzle')!
    const bay = hotendsOf(head)[1]!
    const parkSlot = seq.slotsAfter.findIndex((t, i) => t === 0 && seq.slotsBefore[i] === -1)
    const slot = rig.root.getObjectByName('rack')!.children.find((c) => c.name === 'hotend' && c.userData.slot === parkSlot)!
    expect(worldOf(bay).distanceTo(worldOf(slot))).toBeLessThan(1e-6)
  })

  it('H2C: after a change the rack keeps what the change left, spares included, until the next one', () => {
    const spec = h2c(3)
    const seq = changeSequence(spec, 0, 1, [100, 100, 10], [110, 100, 10], 20)
    expect(seq.slotsBefore).toEqual([1, 2, -1, SPARE, SPARE, SPARE])
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.rest(seq.slotsAfter, seq.rowAfter)
    rig.place(110, 100, 10, 1, null, null)
    rig.root.updateMatrixWorld(true)
    const rack = rig.root.getObjectByName('rack')!
    const shownSlots = rack.children.filter((c) => c.name === 'hotend' && c.visible).map((c) => c.userData.slot as number)
    // Slot 0 gave up tool 1 and is the empty one now; tool 0 went into slot 2; spares stay in 3 to 5.
    expect(shownSlots).toEqual([1, 2, 3, 4, 5])
    rig.rest(null, 0)
    rig.place(100, 100, 10, 0, null, null)
    expect(rack.children.filter((c) => c.name === 'hotend' && c.visible).map((c) => c.userData.slot as number)).toEqual([0, 1, 3, 4, 5])
  })

  it('every head is separate solids: no two parts of it overlap, the lifted nozzle aside', () => {
    for (const spec of [h2d(), h2c(), u1(), xl(), s5()]) {
      const rig = new ToolheadRig()
      rig.setSpec(spec)
      rig.place(100, 100, 10, 0, null, null)
      rig.root.updateMatrixWorld(true)
      const head = rig.root.getObjectByName('nozzle')!
      const parts = boxes(head, rig.root)
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i]!
          const b = parts[j]!
          // The idle nozzle lifts its sock into the body above it, out of sight.
          const lifted = (x: typeof a, y: typeof a) => x.name === 'sock' && y.name === 'body'
          if (lifted(a, b) || lifted(b, a)) continue
          // The UltiMaker lift switch lever is one part, its arm and the pin at its end.
          if (a.parent === b.parent && a.parent?.name === 'lever') continue
          expect(depth(a.box, b.box), `${spec.kind}: ${a.name} into ${b.name}`).toBeLessThanOrEqual(0.01)
        }
    }
  })

  it('every single-nozzle head is separate solids that only touch, with its tip at the move', () => {
    for (const model of HEAD_MODELS) {
      const rig = new ToolheadRig()
      rig.setModel(model)
      rig.visible = true
      rig.place(100, 120, 10, 0, null, null)
      rig.root.updateMatrixWorld(true)
      const head = rig.root.getObjectByName('nozzle')!
      const parts = boxes(head, rig.root)
      expect(parts.length, model).toBeGreaterThan(6)
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) expect(depth(parts[i]!.box, parts[j]!.box), `${model}: ${parts[i]!.name} into ${parts[j]!.name}`).toBeLessThanOrEqual(0.01)
      // Nothing hangs below the nozzle tip.
      for (const p of parts) expect(p.box.min.z, `${model}: ${p.name}`).toBeGreaterThanOrEqual(10.05 - 1e-6)
    }
  })

  it('maps every printer profile to its family head; only the delta falls back to the generic one', () => {
    const file = fileURLToPath(new URL('../../../profiles/machine.json', import.meta.url))
    const ids = Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> }).models)
    expect(ids.length).toBeGreaterThan(40)
    // The U1 always draws its tool changer (toolChangerSpec), so its single head is never shown.
    const generic = ids.filter((id) => headFor(id) === 'generic' && id !== 'snapmaker-u1')
    expect(generic).toEqual(['flsun-v400'])
    expect(headFor('bambu-x1-carbon')).toBe('bambu-x1')
    expect(headFor('bambu-p1s')).toBe('bambu-p1')
    expect(headFor('bambu-a1-mini')).toBe('bambu-a1')
    expect(headFor('prusa-core-one')).toBe('prusa-nextruder')
    expect(headFor('voron-trident-300')).toBe('voron-stealthburner')
    expect(headFor('creality-ender-3-v3-ke')).toBe('creality-sprite')
    expect(headFor('elegoo-neptune-4-max')).toBe('elegoo-neptune4')
    expect(headFor(undefined)).toBe('generic')
  })

  it('H2C: the rack row never decides which nozzle prints', () => {
    const spec = h2c()
    const seq = changeSequence(spec, 2, 5, [100, 100, 10], [110, 100, 10], 20, [[0, 1], [1, 2]])
    for (let t = 0; t <= seq.duration; t += 0.05) expect(poseAt(seq, t).lift).toBe(1)
  })

  it('H2D: both hotends hang under the body, the idle one lifted, and nothing is left outside the head', () => {
    const spec = h2d()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.place(100, 100, 10, 0, null, null)
    rig.root.updateMatrixWorld(true)
    const head = rig.root.getObjectByName('nozzle')!
    const [left, right] = hotendsOf(head)
    expect(worldOf(left!).x).toBeCloseTo(100)
    expect(worldOf(left!).z).toBeCloseTo(10.05)
    expect(worldOf(right!).z).toBeCloseTo(10.05 + 2.5)
    expect(rig.root.getObjectByName('changer')!.children).toHaveLength(0)
  })

  it('U1: the parked toolheads sit at the dock positions and the carriage never enters a parked toolhead or the dock', () => {
    const spec = u1()
    for (const [from, to] of [[0, 2], [3, 1], [1, 0]] as const) {
      const r = sweep(spec, from, to)
      expect(r.worst.depth, r.worst.at).toBeLessThanOrEqual(0.01)
    }
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.place(100, 100, 10, 0, null, null)
    rig.root.updateMatrixWorld(true)
    const parked = rig.root.getObjectByName('dock')!.children.filter((c) => c.name === 'toolhead')
    expect(parked.map((c) => c.visible)).toEqual([false, true, true, true])
    parked.forEach((c, i) => {
      expect(worldOf(c).x).toBeCloseTo(spec.docks!.x[i]!)
      expect(worldOf(c).y).toBeCloseTo(spec.docks!.y)
    })
  })

  it('Prusa XL: the five toolheads park at the firmware\'s dock positions and no part of the head enters the dock or a parked toolhead', () => {
    const spec = xl()
    expect(spec.kind).toBe('xl-dock')
    expect(spec.xl!.x).toEqual([25, 107, 189, 271, 353])
    expect(spec.extruderOf).toEqual([0, 1, 2, 3, 4])
    for (const [from, to] of [[0, 1], [3, 0], [4, 2]] as const) {
      const r = sweep(spec, from, to)
      expect(r.worst.depth, r.worst.at).toBeLessThanOrEqual(0.01)
    }
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.place(100, 100, 10, 2, null, null)
    rig.root.updateMatrixWorld(true)
    const parked = rig.root.getObjectByName('dock')!.children.filter((c) => c.name === 'toolhead')
    expect(parked.map((c) => c.visible)).toEqual([true, true, false, true, true])
    parked.forEach((c, i) => {
      expect(worldOf(c).x).toBeCloseTo(spec.xl!.x[i]!)
      expect(worldOf(c).y).toBeCloseTo(455)
    })
    // The parking sequence follows the firmware: in at the dock's x - 10, sideways to + 0.5, back to the dock, out.
    const seq = changeSequence(spec, 0, 1, [100, 100, 10], [110, 100, 10], 0)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'to dock', 'approach', 'unlock', 'seat', 'park', 'pull back', 'to next', 'insert', 'seat', 'lock', 'lock', 'clear', 'extract', 'heat', 'return', 'lower'])
    expect(seq.phases[5]!.to.slice(0, 2)).toEqual([25, 455])
    expect(seq.phases[12]!.to.slice(0, 2)).toEqual([107 - 9.9, 455])
  })

  it('U1: the toolhead stays in its slot while the carriage slides off it', () => {
    const spec = u1()
    const seq = changeSequence(spec, 0, 2, [100, 100, 10], [110, 100, 10], 5)
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    const release = seq.phases.find((p) => p.name === 'release')!
    const tool = () => worldOf(rig.root.getObjectByName('nozzle')!.getObjectByName('toolhead')!)
    for (const f of [0, 0.5, 0.999]) {
      const p = poseAt(seq, release.t0 + release.move * f)
      rig.place(p.x, p.y, p.z, 2, p, p.slots)
      rig.root.updateMatrixWorld(true)
      expect(tool().x).toBeCloseTo(spec.docks!.x[0]!)
    }
  })
})
