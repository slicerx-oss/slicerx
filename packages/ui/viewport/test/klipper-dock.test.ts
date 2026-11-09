// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Klipper tool changers in Preview (StealthChanger style): which printers dock their tools on the front top frame, the
// docks from the printer's own config or estimated from the nozzle count, the dock path the change plays, and the
// toolhead and docks it draws.
import { describe, expect, it } from 'vitest'
import type { Object3D } from 'three'
import type { ToolDock } from '@slicerx/contracts'
import { DOCK_PITCH, STEALTHCHANGER_PATH, changeSequence, poseAt, toolChangerSpec, type ChangeSequence, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'

const BED = { widthMm: 250, depthMm: 250, heightMm: 250 }
/** A Klipper printer with `n` extruders, as setup saves one with a nozzle per tool. */
const klipper = (n: number, extra: Record<string, unknown> = {}) => ({ gcode_flavor: 'klipper', nozzle_diameter: Array.from({ length: n }, () => '0.4'), travel_speed: '300', ...extra })
const spec = (n: number, docks: ToolDock[] = [], cfg = klipper(n)) => toolChangerSpec('generic-klipper', cfg, BED, n, { toolchanger: { docks } })

/** The project's example T0 (`Toolhead_T0.cfg`) and a second tool one dock pitch along, as Moonraker reports them. */
const MEASURED: ToolDock[] = [
  { tool: 0, parkMm: [28, -71, 381], safeYMm: 20, path: STEALTHCHANGER_PATH.map((q) => ({ y: q.y, z: q.z, ...(q.f !== 1 ? { f: q.f } : {}) })) },
  { tool: 1, parkMm: [104, -71, 381], safeYMm: 20 },
]

const H2_CHUTE = (depth: number): [number, number] => [95.5, depth + 16]
const U1_RACK_Y = (depth: number) => depth + 61.2

const stops = (seq: ChangeSequence) => seq.phases.map((p) => ({ name: p.name, to: p.to, carried: p.carried }))
const near = (a: V3, b: V3) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)

describe('which printers dock their tools on the frame (kindOf)', () => {
  it('gives a Klipper printer declared a tool changer the klipper dock, with two or more nozzles', () => {
    expect(spec(2)?.kind).toBe('klipper-dock')
    expect(spec(4)?.kind).toBe('klipper-dock')
    expect(toolChangerSpec('voron-2.4-350', klipper(3), { widthMm: 350, depthMm: 350, heightMm: 325 }, 3, { toolchanger: { docks: [] } })?.kind).toBe('klipper-dock')
  })

  it('needs the declaration, the Klipper flavor and a second nozzle', () => {
    // Without it the old rules stand (two nozzles look like one head, three like a rack).
    expect(toolChangerSpec('generic-klipper', klipper(2), BED, 2)?.kind).toBe('dual-nozzle')
    expect(toolChangerSpec('generic-klipper', klipper(3), BED, 3)?.kind).toBe('tool-rack')
    expect(spec(2, [], klipper(2, { gcode_flavor: 'marlin' }))?.kind).not.toBe('klipper-dock')
    expect(spec(1)).toBeNull()
  })

  it('keeps the U1, the XL and the IDEX J1 on their own kinds even when declared', () => {
    expect(toolChangerSpec('snapmaker-u1', klipper(4), { widthMm: 270, depthMm: 270, heightMm: 270 }, 4, { toolchanger: { docks: [] } })?.kind).toBe('tool-rack')
    expect(toolChangerSpec('prusa-xl-5-toolhead', klipper(5), { widthMm: 360, depthMm: 360, heightMm: 360 }, 5, { toolchanger: { docks: [] } })?.kind).toBe('xl-dock')
  })
})

describe('the docks', () => {
  it('are estimated from the nozzle count when the printer gave none: centered, one pitch apart, in front over the top', () => {
    const k = spec(3)!.klipper!
    expect(k.docks.map((d) => d.x)).toEqual([125 - DOCK_PITCH, 125, 125 + DOCK_PITCH])
    expect(k.docks.every((d) => d.y === -71 && d.z === 270 && !d.measured)).toBe(true)
    expect(k.safeY).toBe(20)
    expect(k.path).toEqual(STEALTHCHANGER_PATH)
    expect(k.measured).toEqual({ safeY: false, path: false })
  })

  it('take the park points, safe Y and path the printer reported, and estimate only what is missing', () => {
    const k = spec(3, MEASURED)!.klipper!
    expect(k.docks.slice(0, 2)).toEqual([{ x: 28, y: -71, z: 381, measured: true }, { x: 104, y: -71, z: 381, measured: true }])
    expect(k.docks[2]!.measured).toBe(false)
    expect(k.safeY).toBe(20)
    expect(k.measured).toEqual({ safeY: true, path: true })
    expect(k.path[3]).toEqual({ y: 0, z: 0, f: 0.5 })
  })

  it('fall back to estimates for a park point or path that is incomplete', () => {
    const k = spec(2, [{ tool: 0, path: [{ y: 1, z: 1 }] }, { tool: 1, parkMm: [Number.NaN, -71, 381] as [number, number, number] }])!.klipper!
    expect(k.docks.every((d) => !d.measured)).toBe(true)
    expect(k.path).toEqual(STEALTHCHANGER_PATH)
  })
})

describe('the dock path', () => {
  const at: V3 = [100, 120, 10]
  const resume: V3 = [140, 90, 10]

  function check(s: ToolChangerSpec) {
    const k = s.klipper!
    const seq = changeSequence(s, 0, 1, at, resume, 2)
    const a = k.docks[0]!
    const c = k.docks[1]!
    const st = stops(seq)
    expect(st.map((p) => p.name)).toEqual(['lift', 'to dock', 'rise', 'approach', 'dock', 'dock', 'seat', 'unhook', 'clear', 'to next', 'under', 'hook', 'lift out', 'lift out', 'lift out', 'out', 'heat', 'return', 'lower'])
    const by = (name: string, nth = 0) => st.filter((p) => p.name === name)[nth]!
    // Drop-off: along the path from the park point of the tool in hand, in the project's order.
    expect(by('to dock').to).toEqual([a.x, k.safeY, 10 + s.liftMm])
    expect(by('approach').to).toEqual([a.x, a.y + 9.5, a.z + 4])
    expect(by('dock', 0).to).toEqual([a.x, a.y + 9.5, a.z + 2])
    expect(by('dock', 1).to).toEqual([a.x, a.y + 5.5, a.z])
    expect(by('seat').to).toEqual([a.x, a.y, a.z])
    expect(by('unhook').to).toEqual([a.x, a.y, a.z - 10])
    expect(by('clear').to).toEqual([a.x, a.y + 16, a.z - 10])
    // The tool stays in its dock from the unhook on; the head runs empty to the next dock.
    expect(by('seat').carried).toBe(0)
    expect(by('unhook').carried).toBeNull()
    expect(by('clear').carried).toBeNull()
    expect(by('hook').carried).toBeNull()
    expect(by('to next').to).toEqual([c.x, c.y + 16, c.z - 10])
    // Pick-up: the same path in reverse at the next dock.
    expect(by('under').to).toEqual([c.x, c.y, c.z - 10])
    expect(by('hook').to).toEqual([c.x, c.y, c.z])
    expect(by('lift out', 0).to).toEqual([c.x, c.y + 5.5, c.z])
    expect(by('lift out', 2).to).toEqual([c.x, c.y + 9.5, c.z + 4])
    expect(by('lift out', 0).carried).toBe(1)
    expect(by('out').to).toEqual([c.x, k.safeY, c.z + 4])
    expect(st[st.length - 1]!.to).toEqual(resume)
    // The seated move and its reverse run at the path's slow speed.
    const seat = seq.phases.find((p) => p.name === 'seat')!
    expect(seat.limits.speed).toBe(k.pathSpeed.speed * 0.5)
    expect(seq.phases.filter((p) => p.name === 'lift out')[0]!.limits.speed).toBe(k.pathSpeed.speed * 0.5)
    return seq
  }

  it('plays the StealthChanger path at estimated docks', () => {
    const seq = check(spec(2)!)
    expect(seq.slotsBefore).toEqual([-1, 1])
    expect(seq.slotsAfter).toEqual([0, -1])
  })

  it('plays the same path at the docks the printer reported', () => {
    const s = spec(2, MEASURED)!
    check(s)
    const unhook = changeSequence(s, 0, 1, at, resume, 2).phases.find((p) => p.name === 'unhook')!
    expect(near(unhook.to, [28, -71, 371])).toBe(true)
  })

  it('never goes near the H2 chute or the U1 rack, and the head moves smoothly', () => {
    for (const s of [spec(2)!, spec(4)!, spec(2, MEASURED)!]) {
      for (const [from, to] of [[0, 1], [1, 0], [0, s.klipper!.docks.length - 1]] as const) {
        const seq = changeSequence(s, from, to, at, resume, 2)
        let prev = poseAt(seq, 0)
        for (let t = 0; t <= seq.duration + 1e-9; t += 1 / 120) {
          const p = poseAt(seq, t)
          const [cx, cy] = H2_CHUTE(BED.depthMm)
          expect(Math.hypot(p.x - cx, p.y - cy)).toBeGreaterThan(100)
          expect(p.y).toBeLessThan(U1_RACK_Y(BED.depthMm) - 100)
          // The docks are at the front: the head stays in front of the bed's back edge.
          expect(p.y).toBeLessThanOrEqual(Math.max(at[1], resume[1]) + 1e-6)
          expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThan(10)
          prev = p
        }
      }
    }
  })
})

describe('the Klipper tool changer drawing', () => {
  const names = (o: Object3D) => {
    const out: string[] = []
    o.traverse((c) => void out.push(c.name))
    return out
  }

  it('draws the generic head on a shuttle and a dock per tool on the front frame, never the Bambu head or the U1 dock', () => {
    const rig = new ToolheadRig()
    rig.setSpec(spec(3)!)
    rig.visible = true
    const n = names(rig.root)
    expect(n).toContain('shuttle')
    expect(n).toContain('frame bar')
    expect(n.filter((x) => x === 'dock bracket')).toHaveLength(3)
    expect(n.filter((x) => x === 'parked tool')).toHaveLength(3)
    for (const bambuOrU1 of ['cover', 'display', 'chip', 'motor', 'lever', 'beam', 'badge']) expect(n).not.toContain(bambuOrU1)
  })

  it('shows the tool in the head or in its dock as the change goes', () => {
    const s = spec(2)!
    const rig = new ToolheadRig()
    rig.setSpec(s)
    const seq = changeSequence(s, 0, 1, [100, 120, 10], [140, 90, 10], 2)
    const shown = () => {
      const docks: boolean[] = []
      let carried = false
      rig.root.traverse((o) => {
        if (o.name === 'parked tool') docks.push(o.visible)
        if (o.name === 'klipper tool') carried = o.visible
      })
      return { docks, carried }
    }
    const tAt = (name: string) => {
      const p = seq.phases.find((q) => q.name === name)!
      return p.t0 + p.move / 2
    }
    rig.place(100, 120, 10, 0, null, null)
    expect(shown()).toEqual({ docks: [false, true], carried: true })
    rig.place(0, 0, 0, 0, poseAt(seq, tAt('to next')), null)
    expect(shown()).toEqual({ docks: [true, true], carried: false })
    rig.place(0, 0, 0, 1, poseAt(seq, tAt('out')), null)
    expect(shown()).toEqual({ docks: [true, false], carried: true })
    // The dock stands on the frame: it keeps its height whatever the head's.
    let dockZ = Number.NaN
    rig.root.traverse((o) => void (o.name === 'changer' && (dockZ = o.position.z)))
    expect(dockZ).toBe(0)
  })
})
