// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool change model: each printer's sequence, its timing and the continuity of the head's motion.
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { ChangeClock, SPARE, changeSequence, moveDistance, moveTime, poseAt, printedTop, rackStateBefore, toolChangerSpec, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { Toolpaths, changePoints } from '../src/toolpaths'
import { buildPreview, type Seg } from './sxpv-fixture'

const h2d = (tools = 2) =>
  toolChangerSpec(
    'bambu-h2d',
    { nozzle_diameter: ['0.4', '0.4'], filament_map: ['1', '2', '2'], machine_switch_extruder_time: '5.6', machine_load_filament_time: '26', machine_unload_filament_time: '26', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
    { widthMm: 350, depthMm: 320, heightMm: 325 },
    tools,
  )!
const h2c = (tools = 3) =>
  toolChangerSpec(
    'bambu-h2c',
    { nozzle_diameter: ['0.4', '0.4'], filament_map: ['2', '2', '2'], extruder_max_nozzle_count: ['1', '6'], machine_switch_extruder_time: '5', machine_load_filament_time: '15', machine_unload_filament_time: '15', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
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

/** The largest jump between poses 1/120 s apart, and the largest speed, over the whole sequence. */
function scan(spec: ToolChangerSpec, seq: ReturnType<typeof changeSequence>) {
  const dt = 1 / 120
  let maxStep = 0
  let maxSpeed = 0
  let prev = poseAt(seq, 0)
  for (let t = dt; t <= seq.duration + dt; t += dt) {
    const p = poseAt(seq, t)
    const step = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)
    maxStep = Math.max(maxStep, step)
    maxSpeed = Math.max(maxSpeed, step / dt)
    prev = p
  }
  return { maxStep, maxSpeed, limit: Math.max(spec.travel.speed, spec.z.speed) }
}

describe('motion profile', () => {
  it('times a move as a trapezoid or a triangle and covers the whole distance', () => {
    const l = { speed: 100, accel: 1000 }
    expect(moveTime(50, l)).toBeCloseTo(0.5 + 0.1, 9)
    expect(moveTime(5, l)).toBeCloseTo(2 * Math.sqrt(5 / 1000), 9)
    expect(moveDistance(50, l, moveTime(50, l))).toBeCloseTo(50, 6)
    expect(moveDistance(5, l, moveTime(5, l))).toBeCloseTo(5, 6)
    expect(moveDistance(50, l, 0.05)).toBeCloseTo(1.25, 9)
    expect(moveDistance(50, l, 0.3)).toBeCloseTo(5 + 100 * 0.2, 9)
  })
})

describe('ChangeClock', () => {
  it('counts a switch, a load and an unload like the engine', () => {
    const k = new ChangeClock(h2d(3), 2)
    expect(k.change(0)).toBe(26)
    expect(k.change(1)).toBeCloseTo(31.6)
    expect(k.change(0)).toBeCloseTo(5.6)
    expect(k.change(2)).toBeCloseTo(5.6 + 52)
    expect(k.change(2)).toBe(0)
    const u = new ChangeClock(u1(), 4)
    expect(u.change(0)).toBe(0)
    expect(u.change(3)).toBe(5)
  })
})

describe('toolChangerSpec', () => {
  it('names the mechanism from the profile id or the nozzle count', () => {
    expect(h2d().kind).toBe('dual-nozzle')
    expect(h2c().kind).toBe('hotend-rack')
    expect(u1().kind).toBe('tool-rack')
    // One nozzle: a Bambu printer with a known chute swaps filament there; others keep the head where it is.
    expect(toolChangerSpec('bambu-p1s', { nozzle_diameter: ['0.4'] }, { widthMm: 256, depthMm: 256, heightMm: 256 }, 4)?.kind).toBe('filament-swap')
    expect(toolChangerSpec('bambu-p2s', { nozzle_diameter: ['0.4'] }, { widthMm: 256, depthMm: 256, heightMm: 256 }, 4)).toBeNull()
    expect(toolChangerSpec('voron-2.4-350', { nozzle_diameter: ['0.4'] }, { widthMm: 350, depthMm: 350, heightMm: 340 }, 4)).toBeNull()
    expect(toolChangerSpec(undefined, { nozzle_diameter: ['0.4', '0.4', '0.4'] }, { widthMm: 300, depthMm: 300, heightMm: 300 }, 3)?.kind).toBe('tool-rack')
  })
  it('reads the U1 dock from the printer configuration', () => {
    const d = u1().docks!
    expect(d.x).toEqual([35.0, 102.7, 170.2, 237.7])
    expect(d.y).toBeCloseTo(332.2 - 1)
    expect(d.strokeX).toBe(10)
    expect(d.grab.speed).toBe(10)
  })
})

describe('changeSequence', () => {
  const at: V3 = [100, 100, 10]
  const resume: V3 = [120, 90, 10]

  it('H2D: lifts, goes to the chute, swaps nozzles there, exits along the back and returns, in the profile time plus its moves', () => {
    const spec = h2d()
    const seq = changeSequence(spec, 0, 1, at, resume, 5.6)
    const names = seq.phases.map((p) => p.name)
    expect(names).toEqual(['lift', 'to chute', 'cut', 'switch', 'load', 'wipe', 'exit', 'exit', 'return', 'lower'])
    const moves = seq.phases.reduce((a, p) => a + p.move, 0)
    expect(seq.duration).toBeCloseTo(moves + 5.6, 6)
    const chute = seq.phases[2]!
    expect([chute.to[0], chute.to[1], chute.to[2]]).toEqual([95.5, 336, 13])
    expect(poseAt(seq, 0).lift).toBe(0)
    expect(poseAt(seq, seq.duration).lift).toBe(1)
    const p = poseAt(seq, seq.duration)
    expect([p.x, p.y, p.z]).toEqual(resume)
    const s = scan(spec, seq)
    expect(s.maxSpeed).toBeLessThanOrEqual(s.limit * 1.01)
  })

  it('H2C: parks the hotend in the lowest empty slot, picks the next, and the rack keeps its state across changes', () => {
    const spec = h2c()
    const seq = changeSequence(spec, 0, 1, at, resume, 35)
    const names = seq.phases.map((p) => p.name)
    expect(names.slice(0, 3)).toEqual(['lift', 'to chute', 'cut'])
    expect(names).toContain('dock')
    expect(names).toContain('unlatch')
    expect(names).toContain('engage')
    expect(names).toContain('latch')
    // Tools 1 and 2 wait on the rack in slots 0 and 1, tool 0 is in the head, slot 2 is the empty one and spare hotends fill the rest;
    // after the change tool 0 sits in slot 2 and slot 0 is the empty one.
    expect(seq.slotsBefore).toEqual([1, 2, -1, SPARE, SPARE, SPARE])
    expect(seq.slotsAfter).toEqual([-1, 2, 0, SPARE, SPARE, SPARE])
    expect(poseAt(seq, 0).carried).toBe(0)
    expect(poseAt(seq, seq.duration).carried).toBe(1)
    const released = seq.phases.find((p) => p.name === 'leave')!
    expect(poseAt(seq, released.t0 + released.move / 2).carried).toBeNull()
    const s = scan(spec, seq)
    expect(s.maxSpeed).toBeLessThanOrEqual(s.limit * 1.01)
    const next = changeSequence(spec, 1, 2, at, resume, 35, [[0, 1]])
    expect(next.slotsBefore).toEqual([-1, 2, 0, SPARE, SPARE, SPARE])
    expect(next.slotsAfter).toEqual([1, -1, 0, SPARE, SPARE, SPARE])
    expect(rackStateBefore(spec, [[0, 1], [1, 2]]).inHead).toBe(2)
    // A change to the fixed left nozzle is a nozzle switch at the chute, no rack trip.
    const left = toolChangerSpec('bambu-h2c', { nozzle_diameter: ['0.4', '0.4'], filament_map: ['1', '2'], machine_switch_extruder_time: '5' }, spec.bed, 2)!
    const sw = changeSequence(left, 1, 0, at, resume, 5)
    expect(sw.phases.map((p) => p.name)).not.toContain('dock')
  })

  it('U1: pushes into the dock, releases sideways, grabs the next head and comes back, slower at the dock', () => {
    const spec = u1()
    const seq = changeSequence(spec, 0, 2, at, resume, 5)
    const names = seq.phases.map((p) => p.name)
    expect(names).toEqual(['lift', 'to dock', 'push in', 'seat', 'release', 'released', 'back out', 'to next', 'push in', 'seat', 'grab', 'settle', 'pull out', 'return', 'lower'])
    const seat = seq.phases[3]!
    expect([seat.to[0], seat.to[1]]).toEqual([35, 331.2])
    const grab = seq.phases[10]!
    expect(grab.limits.speed).toBe(10)
    expect(grab.to[0]).toBeCloseTo(170.2)
    expect(seq.slotsBefore).toEqual([-1, 1, 2, 3])
    expect(seq.slotsAfter).toEqual([0, 1, -1, 3])
    expect(poseAt(seq, seq.phases[6]!.t0).carried).toBeNull()
    expect(poseAt(seq, seq.duration).carried).toBe(2)
    expect(seq.duration).toBeGreaterThan(5)
    expect(seq.duration).toBeLessThan(20)
    const s = scan(spec, seq)
    expect(s.maxSpeed).toBeLessThanOrEqual(s.limit * 1.01)
    expect(s.maxStep).toBeLessThan(spec.travel.speed / 120 + 0.01)
  })

  it('is the same pose for the same time, scrubbed forward or back', () => {
    const spec = u1()
    const seq = changeSequence(spec, 1, 3, at, resume, 5)
    const forward = [0.3, 1.1, 2.4, 5.5, seq.duration - 0.2].map((t) => poseAt(seq, t))
    const backward = [seq.duration - 0.2, 5.5, 2.4, 1.1, 0.3].map((t) => poseAt(seq, t)).reverse()
    expect(backward).toEqual(forward)
  })
})

describe('Toolpaths with a tool changer', () => {
  const seg = (x: number, tool: number): Seg => ({ a: [x, 0], b: [x + 1, 0], feature: FEATURE.outerWall, tool })
  const preview = buildPreview([[seg(0, 0), seg(1, 0), seg(2, 1)], [seg(3, 1), seg(4, 0)]])

  it('lists the change points and plays a change at the head', () => {
    expect(changePoints(preview)).toEqual([
      { segment: 2, from: 0, to: 1 },
      { segment: 4, from: 1, to: 0 },
    ])
    const t = new Toolpaths()
    t.set(preview)
    t.setToolChanger(u1())
    const head = t.root.children.find((c) => c.name === 'toolhead')!
    const nozzle = head.children.find((c) => c.name === 'nozzle')!
    t.setRange(0, 0, 2)
    expect(nozzle.position.x).toBeCloseTo(2)
    // Half a second into the change before segment 2 the head has left the path.
    t.setToolChange({ segment: 2, seconds: 0.5, fixed: 5 })
    expect(nozzle.position.y).toBeGreaterThan(10)
    t.setToolChange(null)
    expect(nozzle.position.x).toBeCloseTo(2)
    expect(nozzle.position.y).toBeCloseTo(0)
    // The sequence built for the rack's rest state (no seconds) must not stand in for the timed one.
    t.setToolChange({ segment: 2, seconds: 4, fixed: 5 })
    expect(nozzle.position.y).toBeGreaterThan(200)
  })
})

describe('filament swap at the chute (Bambu Lab, one nozzle)', () => {
  const a1 = () => toolChangerSpec('bambu-a1', { nozzle_diameter: ['0.4'], machine_load_filament_time: 25, machine_unload_filament_time: 29 }, { widthMm: 256, depthMm: 256, heightMm: 256 }, 2)!
  const x1 = () => toolChangerSpec('bambu-x1-carbon', { nozzle_diameter: ['0.4'], machine_load_filament_time: 29, machine_unload_filament_time: 28 }, { widthMm: 256, depthMm: 256, heightMm: 250 }, 2)!

  it('A1: cuts at the right end of X, flushes at the left end and wipes to the right, as the change G-code moves', () => {
    const seq = changeSequence(a1(), 0, 1, [100, 60, 2], [110, 60, 2], 54)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'to cutter', 'cut', 'to chute', 'load', 'wipe', 'exit', 'exit', 'return', 'lower'])
    expect(seq.phases[1]!.to.slice(0, 2)).toEqual([267, 60])
    expect(seq.phases[3]!.to.slice(0, 2)).toEqual([-48.2, 128])
    expect(seq.phases[5]!.to.slice(0, 2)).toEqual([-38.2, 128])
    // The firmware's seconds are the cut and the load; the head carries the new filament from the load on.
    expect(seq.phases[2]!.dwell + seq.phases[4]!.dwell).toBeCloseTo(54, 9)
    expect(seq.phases[3]!.carried).toBe(0)
    expect(seq.phases[4]!.carried).toBe(1)
  })

  it('X1 and P1: cut at the back, flush at X 54, Y 265, wipe right along the back', () => {
    const seq = changeSequence(x1(), 0, 1, [100, 60, 2], [110, 60, 2], 57)
    expect(seq.phases[1]!.to.slice(0, 2)).toEqual([70, 265])
    expect(seq.phases[3]!.to.slice(0, 2)).toEqual([54, 265])
    expect(seq.phases[5]!.to.slice(0, 2)).toEqual([70, 265])
  })
})

describe('change lift over the print', () => {
  const spec = (gcode: string) =>
    toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], change_filament_gcode: gcode, travel_speed: '350' }, { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)!

  it('lifts over the highest layer printed so far when the change G-code says max_layer_z, as the engine checks it', () => {
    const at: [number, number, number] = [50, 50, 0.6]
    const over = changeSequence(spec('G1 Z{max_layer_z + 2}'), 0, 1, at, at, 5, [], 30)
    const own = changeSequence(spec('T[next_extruder]'), 0, 1, at, at, 5, [], 30)
    const high = (s: typeof over) => Math.max(...s.phases.map((p) => p.to[2]))
    expect(high(over)).toBeCloseTo(30 + 3.5)
    expect(high(own)).toBeCloseTo(0.6 + 3.5)
  })

  it('reads the highest layer top printed up to a segment, objects printed one after the other included', () => {
    const b = { layerCount: 4, layerZ: new Float32Array([0.2, 30, 0.2, 0.4]), layerStart: new Uint32Array([0, 10, 20, 30, 40]) } as unknown as Parameters<typeof printedTop>[0]
    expect(printedTop(b, 5)).toBeCloseTo(0.2)
    expect(printedTop(b, 25)).toBeCloseTo(30)
    expect(printedTop(b, 35)).toBeCloseTo(30)
  })
})
