// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Prusa Core One with INDX in Preview: which printers get the front docks, where the docks stand, the change it
// plays (park, pick, heat, purge, return), that the head never runs into a dock, a parked tool, the bed or past the
// frame, and the Smart Head, tools and docks it draws.
import { describe, expect, it } from 'vitest'
import { Box3, type Mesh, type Object3D } from 'three'
import { INDX_PITCH, SPARE, changeSequence, poseAt, toolChangerSpec, type ChangeSequence, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'

/** The INDX build volume (Prusa's product page): 248 x 205 x 270 mm. */
const BED = { widthMm: 248, depthMm: 205, heightMm: 270 }
const indx = (n = 8, extra: Record<string, unknown> = {}) => ({ gcode_flavor: 'marlin2', nozzle_diameter: Array.from({ length: n }, () => '0.4'), travel_speed: '300', machine_tool_change_time: '12', ...extra })
const spec = (tools: number, n = 8) => toolChangerSpec('prusa-core-one-indx', indx(n), BED, tools)!

const stops = (seq: ChangeSequence) => seq.phases.map((p) => ({ name: p.name, to: p.to, carried: p.carried }))
const at: V3 = [80, 120, 10]
const resume: V3 = [160, 60, 10]

describe('which printers get the front docks (kindOf)', () => {
  it('gives the Core One INDX profile the front dock with two or more nozzles', () => {
    expect(spec(2).kind).toBe('front-dock')
    expect(spec(4, 4).kind).toBe('front-dock')
  })

  it('leaves the plain Core One, a one nozzle INDX and the other changers alone', () => {
    expect(toolChangerSpec('prusa-core-one', { nozzle_diameter: ['0.4'] }, { widthMm: 250, depthMm: 220, heightMm: 270 }, 2)).toBeNull()
    expect(toolChangerSpec('prusa-core-one-indx', indx(1), BED, 1)).toBeNull()
    expect(toolChangerSpec('prusa-xl-5-toolhead', indx(5), { widthMm: 360, depthMm: 360, heightMm: 360 }, 5)?.kind).toBe('xl-dock')
    expect(toolChangerSpec('snapmaker-u1', indx(4), { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)?.kind).toBe('tool-rack')
  })
})

describe('the docks', () => {
  it('stand in one row along the front, one tool pitch apart and centered on the bed', () => {
    const k = spec(2).frontDock!
    expect(k.x).toHaveLength(8)
    expect(k.x[0]).toBeCloseTo(124 - 3.5 * INDX_PITCH)
    expect(k.x[7]).toBeCloseTo(124 + 3.5 * INDX_PITCH)
    for (let i = 1; i < 8; i++) expect(k.x[i]! - k.x[i - 1]!).toBeCloseTo(34)
    // The row of eight is 266.5 mm wide, wider than the bed, and centered on it; the docks stand in front of the bed,
    // with a tool's depth plus 1 mm to the clearance Y.
    expect(Math.max(...k.x) - Math.min(...k.x) + 28.5).toBeCloseTo(266.5)
    expect((Math.min(...k.x) + Math.max(...k.x)) / 2).toBeCloseTo(BED.widthMm / 2)
    expect(k.dockY).toBeLessThan(0)
    expect(k.clearY - k.dockY).toBeGreaterThanOrEqual(26)
    expect(k.seatRise).toBe(2)
    // The purge collector stands off the bed, clear of the dock row.
    expect(k.purge.x).toBeGreaterThan(BED.widthMm)
    expect(k.purge.y).toBeGreaterThan(k.clearY)
  })
})

describe('the change', () => {
  it('parks, picks, heats, purges and returns in the INDX order', () => {
    const s = spec(2)
    const k = s.frontDock!
    const seq = changeSequence(s, 0, 1, at, resume, 12)
    const st = stops(seq)
    expect(st.map((p) => p.name)).toEqual(['lift', 'to dock', 'insert', 'release', 'back out', 'to next', 'insert', 'latch', 'extract', 'heat', 'to purge', 'blob', 'wipe', 'wipe', 'return', 'lower'])
    const up = 10 + s.liftMm
    const [a, c] = [k.x[0]!, k.x[1]!]
    expect(st.map((p) => p.to)).toEqual([
      [at[0], at[1], up],
      [a, k.clearY, up],
      [a, k.dockY, up],
      [a, k.dockY, up],
      [a, k.clearY, up],
      [c, k.clearY, up],
      [c, k.dockY, up],
      [c, k.dockY, up],
      [c, k.clearY, up],
      [c, k.clearY, up],
      [k.purge.x, k.purge.y, up],
      [k.purge.x, k.purge.y, up],
      [k.purge.wipe[0]![0], k.purge.wipe[0]![1], up],
      [k.purge.wipe[1]![0], k.purge.wipe[1]![1], up],
      [resume[0], resume[1], up],
      resume,
    ])
    // The tool in hand stays in the head up to the release; the head runs empty to the next dock and leaves with tool 1.
    expect(st.map((p) => p.carried)).toEqual([0, 0, 0, null, null, null, null, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    // Spares fill the docks the print does not use.
    expect(seq.slotsBefore).toEqual([-1, 1, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE])
    expect(seq.slotsAfter).toEqual([0, -1, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE])
  })

  it('takes the profile change time when the moves fit in it, and never less than the moves plus the shortest heat', () => {
    const s = spec(2)
    const near = changeSequence(s, 0, 1, at, resume, 12)
    expect(near.duration).toBeCloseTo(12, 6)
    const heat = (seq: ChangeSequence) => seq.phases.find((p) => p.name === 'heat')!.dwell
    expect(heat(near)).toBeGreaterThan(4)
    // From one end of the row to the other the moves take longer: the heat keeps its 4 s.
    const far = changeSequence(spec(8), 0, 7, [10, 200, 10], [240, 200, 10], 12)
    expect(heat(far)).toBeGreaterThanOrEqual(4)
    expect(far.duration).toBeGreaterThanOrEqual(12 - 1e-9)
  })
})

/** World boxes of the visible meshes under `o`, each shrunk by 0.05 mm so faces that only touch do not count. */
function boxes(o: Object3D, skip: (m: Object3D) => boolean = () => false): { name: string; box: Box3; owner: Object3D }[] {
  const out: { name: string; box: Box3; owner: Object3D }[] = []
  o.updateMatrixWorld(true)
  const shown = (m: Object3D) => {
    for (let p: Object3D | null = m; p; p = p.parent) if (!p.visible && p.name !== 'toolhead') return false
    return true
  }
  o.traverse((m) => {
    if (!(m as Mesh).isMesh || !shown(m) || m.name === 'shadow' || skip(m)) return
    const box = new Box3().setFromObject(m).expandByScalar(-0.05)
    let owner: Object3D = m
    while (owner.parent && owner.parent !== o && owner.userData.slot === undefined) owner = owner.parent
    out.push({ name: m.name, box, owner })
  })
  return out
}

describe('collisions and smooth motion', () => {
  const cases: [ToolChangerSpec, number, number][] = [
    [spec(2), 0, 1],
    [spec(2), 1, 0],
    [spec(4), 0, 3],
    [spec(8), 7, 2],
    [spec(8), 3, 4],
  ]

  it('never runs the head into a dock, a parked tool, the bed or past the frame, and never jumps', () => {
    for (const [s, from, to] of cases) {
      const k = s.frontDock!
      const seq = changeSequence(s, from, to, at, resume, 12)
      const rig = new ToolheadRig()
      rig.setSpec(s)
      rig.visible = true
      const head = rig.root.getObjectByName('nozzle')!
      const fixed = rig.root.getObjectByName('changer')!
      let prev = poseAt(seq, 0)
      for (let i = 0; i * (1 / 120) <= seq.duration + 1e-9; i++) {
        const t = i / 120
        const p = poseAt(seq, t)
        expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThan(10)
        prev = p
        // The drawing every 1/20 s.
        if (i % 6 !== 0) continue
        rig.place(0, 0, 0, from, p, null)
        // The parked tool at the dock the head stands in front of is the one it hands over or takes.
        const serving = p.y < k.clearY - 0.5 ? k.x.findIndex((x) => Math.abs(x - p.x) < 0.5) : -1
        const hb = boxes(head, (m) => m.name === 'blob')
        const fb = boxes(fixed, (m) => {
          for (let q: Object3D | null = m; q; q = q.parent) if (q.userData.slot === serving && q.name === 'tool') return true
          return false
        })
        for (const h of hb) for (const f of fb) expect(h.box.intersectsBox(f.box), `${from}-${to} ${p.phase} t ${t.toFixed(3)}: head ${h.name} meets ${f.name}`).toBe(false)
        // The nozzle never goes under the print's top, and off the bed it stays lifted.
        expect(p.z).toBeGreaterThanOrEqual(Math.min(at[2], resume[2]) - 1e-9)
        if (p.y < 0 || p.x > BED.widthMm) expect(p.z).toBeCloseTo(10 + s.liftMm, 6)
        // The frame: no further forward than a seated tool, no further back than the moves, inside the X travel.
        expect(p.y).toBeGreaterThanOrEqual(k.dockY - 1e-9)
        expect(p.y).toBeLessThanOrEqual(Math.max(at[1], resume[1], k.purge.y, ...k.purge.wipe.map((w) => w[1])) + 1e-9)
        expect(p.x).toBeGreaterThanOrEqual(Math.min(...k.x) - 1e-9)
        expect(p.x).toBeLessThanOrEqual(k.purge.x + 1e-9)
      }
    }
  }, 60_000)
})

describe('the INDX drawing', () => {
  const names = (o: Object3D) => {
    const out: string[] = []
    o.traverse((c) => void out.push(c.name))
    return out
  }

  it('draws the Smart Head, a passive tool and a dock with its tool for each nozzle, never the Bambu head, the U1 or the Klipper dock', () => {
    const rig = new ToolheadRig()
    rig.setSpec(spec(2))
    rig.visible = true
    const n = names(rig.root)
    for (const own of ['smart head', 'coupling plate', 'coil', 'frame bar', 'purge collector', 'wiper']) expect(n).toContain(own)
    expect(n.filter((x) => x === 'dock front')).toHaveLength(8)
    expect(n.filter((x) => x === 'tool')).toHaveLength(9)
    for (const other of ['cover', 'display', 'chip', 'motor', 'lever', 'beam', 'badge', 'shuttle', 'dock bracket', 'parked tool']) expect(n).not.toContain(other)
  })

  it('shows the tool in the head or in its dock as the change goes, spares parked, the docks at the head height', () => {
    const s = spec(2)
    const rig = new ToolheadRig()
    rig.setSpec(s)
    const seq = changeSequence(s, 0, 1, at, resume, 12)
    const shown = () => {
      const docks: boolean[] = []
      let carried = false
      for (const c of rig.root.getObjectByName('nozzle')!.children) if (c.name === 'tool') carried = c.visible
      rig.root.getObjectByName('dock')!.traverse((o) => void (o.name === 'tool' && docks.push(o.visible)))
      return { docks, carried }
    }
    const tAt = (name: string, f = 0.5) => {
      const p = seq.phases.find((q) => q.name === name)!
      return p.t0 + (p.move + p.dwell) * f
    }
    rig.place(80, 120, 10, 0, null, null)
    expect(shown()).toEqual({ docks: [false, true, true, true, true, true, true, true], carried: true })
    rig.place(0, 0, 0, 0, poseAt(seq, tAt('to next')), null)
    expect(shown()).toEqual({ docks: [true, true, true, true, true, true, true, true], carried: false })
    rig.place(0, 0, 0, 1, poseAt(seq, tAt('to purge')), null)
    expect(shown()).toEqual({ docks: [true, false, true, true, true, true, true, true], carried: true })
    expect(rig.root.getObjectByName('changer')!.position.z).toBeCloseTo(10 + s.liftMm + 0.05, 6)
    // A parked tool stands the seat rise higher; halfway through the release the dock has lifted it half of that.
    const parked = (i: number) => {
      let z = Number.NaN
      rig.root.getObjectByName('dock')!.traverse((o) => void (o.name === 'tool' && o.userData.slot === i && (z = o.position.z)))
      return z
    }
    expect(parked(5)).toBe(2)
    rig.place(0, 0, 0, 0, poseAt(seq, tAt('release')), null)
    expect(parked(0)).toBeCloseTo(1, 1)
    // The blob grows under the nozzle at the purge collector.
    rig.place(0, 0, 0, 1, poseAt(seq, tAt('blob', 0.99)), null)
    expect(rig.root.getObjectByName('blob')!.visible).toBe(true)
    rig.place(0, 0, 0, 1, poseAt(seq, tAt('return')), null)
    expect(rig.root.getObjectByName('blob')!.visible).toBe(false)
  })
})
