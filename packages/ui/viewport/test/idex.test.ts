// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// IDEX printers in Preview: which printers park a carriage at its end of X, the park path the change plays, and the two
// carriages the toolhead draws on one rail.
import { describe, expect, it } from 'vitest'
import { Box3, type Mesh, type Object3D } from 'three'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { changeSequence, poseAt, toolChangerSpec, type ChangeSequence, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'

type Settings = Record<string, unknown>
const read = <T>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as T
const machine = read<{ models: Record<string, { machine: Settings }> }>('../../../profiles/machine.json').models
const catalog = read<{ printers: { id: string; kinematics: string; buildVolume: { x: number; y: number; z: number } }[] }>('../../../settings/profiles/printers.json').printers
const kinematicsOf = (id: string) => catalog.find((p) => p.id === id)?.kinematics

/** The spec the app builds: the printer's machine settings and the catalog's kinematics. */
function specOf(id: string, cfg: Settings = machine[id]?.machine ?? {}, tools = 2): ToolChangerSpec | null {
  const kin = kinematicsOf(id)
  const v = catalog.find((p) => p.id === id)?.buildVolume
  return toolChangerSpec(id, cfg, { widthMm: v?.x ?? 300, depthMm: v?.y ?? 300, heightMm: v?.z ?? 300 }, tools, kin ? { kinematics: kin } : {})
}

const j1 = () => specOf('snapmaker-j1')!
/** The Sovol SV04 as its two-extruder settings would give it: two nozzles, a 300 mm bed. */
const sv04 = () => specOf('sovol-sv04', { nozzle_diameter: ['0.4', '0.4'], printable_area: ['0x0', '300x0', '300x300', '0x300'], travel_speed: '150' })!

const H2_CHUTE = (depth: number): [number, number] => [95.5, depth + 16]

/** Each carriage's nozzle X, the shared y and z, every 1/120 s through the change. */
function track(seq: ChangeSequence) {
  const out: { t: number; x: [number, number]; y: number; z: number; active: number; phase: string }[] = []
  for (let t = 0; t <= seq.duration + 1e-9; t += 1 / 120) {
    const p = poseAt(seq, t)
    out.push({ t, x: p.carriages!, y: p.y, z: p.z, active: p.active!, phase: p.phase })
  }
  return out
}

describe('which printers park a carriage (kindOf)', () => {
  it('reads the catalog kinematics before the nozzle count: the J1 and the SV04 are IDEX', () => {
    expect(kinematicsOf('snapmaker-j1')).toBe('idex')
    expect(kinematicsOf('sovol-sv04')).toBe('idex')
    expect(j1().kind).toBe('idex-park')
    expect(sv04().kind).toBe('idex-park')
  })

  it('plays nothing on an IDEX printer whose settings have one extruder (the SV04 today: one nozzle, manual swaps)', () => {
    expect(specOf('sovol-sv04', { nozzle_diameter: ['0.4'] })).toBeNull()
  })

  it('plays nothing on the Snapmaker Artisan until its mechanism is checked', () => {
    expect(machine['snapmaker-artisan']?.machine['nozzle_diameter']).toHaveLength(2)
    expect(specOf('snapmaker-artisan')).toBeNull()
  })

  it('keeps the H2D, H2C, U1 and the one-nozzle printers as they were', () => {
    expect(specOf('bambu-h2d', { nozzle_diameter: ['0.4', '0.4'] })?.kind).toBe('dual-nozzle')
    expect(specOf('bambu-h2c', { nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'] })?.kind).toBe('hotend-rack')
    expect(specOf('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'] }, 4)?.kind).toBe('tool-rack')
    expect(specOf('bambu-a1', { nozzle_diameter: ['0.4'] }, 4)?.kind).toBe('filament-swap')
    expect(specOf('voron-2.4-350', { nozzle_diameter: ['0.4'] }, 4)).toBeNull()
  })

  it('parks each carriage one carriage width outside the printable X, and only the J1 swaps both at once', () => {
    // The J1's printable area runs from X 0 to 324 (machine.json).
    expect(j1().idex).toEqual({ park: [-50, 374], concurrent: true, width: 50 })
    expect(sv04().idex).toEqual({ park: [-50, 350], concurrent: false, width: 50 })
    // One tool per carriage, in order, with no filament map.
    expect(j1().extruderOf).toEqual([0, 1])
  })
})

describe('the IDEX park path', () => {
  const at: V3 = [120, 80, 5]
  const resume: V3 = [180, 110, 5]

  it('J1, left to right: lifts, the left carriage runs to its end while the right one comes in, heat wait, down', () => {
    const spec = j1()
    const seq = changeSequence(spec, 0, 1, at, resume, 0)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'switch', 'heat', 'lower'])
    const [lift, sw, heat, lower] = seq.phases
    const up = 5 + spec.liftMm
    expect(lift!.to).toEqual([120, 80, up])
    expect(lift!.idle).toEqual([374, 374])
    // The switch is the new carriage's move from its end to the next move; the old one leaves for its end in the same move.
    expect(sw!.state).toBe(1)
    expect(sw!.carried).toBe(1)
    expect(sw!.from).toEqual([374, 80, up])
    expect(sw!.to).toEqual([180, 110, up])
    expect(sw!.idle).toEqual([120, -50])
    // The move lasts as long as the longer of the two runs (the old carriage's 170 mm against the new one's 196).
    expect(sw!.move).toBeGreaterThan(0)
    expect(heat!.dwell).toBeCloseTo(0.8)
    expect(lower!.to).toEqual(resume)
    // Before and after: the old carriage at the move and the other parked; then the reverse.
    expect(poseAt(seq, 0).carriages).toEqual([120, 374])
    expect(poseAt(seq, seq.duration).carriages).toEqual([-50, 180])
    expect(poseAt(seq, seq.duration).active).toBe(1)
    // Mid switch both carriages are on their way.
    const mid = poseAt(seq, sw!.t0 + sw!.move / 2)
    expect(mid.carriages![0]).toBeLessThan(120)
    expect(mid.carriages![0]).toBeGreaterThan(-50)
    expect(mid.carriages![1]).toBeLessThan(374)
    expect(mid.carriages![1]).toBeGreaterThan(180)
  })

  it('J1, right to left: the right carriage parks at the right end and the left one comes in from the left', () => {
    const seq = changeSequence(j1(), 1, 0, resume, at, 0)
    expect(poseAt(seq, 0).carriages).toEqual([-50, 180])
    expect(poseAt(seq, seq.duration).carriages).toEqual([120, 374])
    expect(poseAt(seq, seq.duration).active).toBe(0)
  })

  it('SV04: parks the old carriage first, then the new one comes in', () => {
    const spec = sv04()
    const seq = changeSequence(spec, 0, 1, at, resume, 2)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'park', 'unpark', 'heat', 'lower'])
    const [, park, unpark, heat] = seq.phases
    expect(park!.state).toBe(0)
    expect(park!.to[0]).toBe(-50)
    expect(park!.idle).toEqual([350, 350])
    expect(unpark!.state).toBe(1)
    expect(unpark!.from[0]).toBe(350)
    expect(unpark!.to).toEqual([180, 110, 5 + spec.liftMm])
    expect(unpark!.idle).toEqual([-50, -50])
    expect(heat!.dwell).toBe(2)
    // Sequential takes longer than the same change done at once.
    const atOnce = changeSequence({ ...spec, idex: { ...spec.idex!, concurrent: true } }, 0, 1, at, resume, 2)
    expect(seq.duration).toBeGreaterThan(atOnce.duration)
  })

  it('swaps in place when both filaments print on one carriage', () => {
    const spec = specOf('snapmaker-j1', { ...machine['snapmaker-j1']!.machine, filament_map: ['1', '1'] })!
    const seq = changeSequence(spec, 0, 1, at, at, 3)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'swap', 'lower'])
    expect(poseAt(seq, seq.duration / 2).carriages).toEqual([120, 374])
  })

  it('never goes to the H2 chute, keeps the carriages apart and moves each one smoothly', () => {
    for (const [spec, from, to] of [[j1(), 0, 1], [j1(), 1, 0], [sv04(), 0, 1], [sv04(), 1, 0]] as const) {
      const seq = changeSequence(spec, from, to, from === 0 ? at : resume, from === 0 ? resume : at, 1)
      const chute = H2_CHUTE(spec.bed.depthMm)
      for (const p of seq.phases) expect(Math.hypot(p.to[0] - chute[0], p.to[1] - chute[1])).toBeGreaterThan(1)
      const poses = track(seq)
      for (let i = 1; i < poses.length; i++) {
        const a = poses[i - 1]!
        const b = poses[i]!
        // Neither carriage jumps: at most the travel speed's distance in 1/120 s (plus rounding).
        for (const c of [0, 1]) expect(Math.abs(b.x[c]! - a.x[c]!)).toBeLessThanOrEqual(spec.travel.speed / 120 + 1e-6)
        // The left carriage stays left of the right one by a carriage width.
        expect(b.x[1] - b.x[0]).toBeGreaterThanOrEqual(spec.idex!.width - 1e-6)
      }
    }
  })
})

describe('the IDEX toolhead', () => {
  const solids = (rig: ToolheadRig, carriage: number): Box3 => {
    rig.root.updateMatrixWorld(true)
    const box = new Box3()
    const head = rig.root.getObjectByName('nozzle')!
    head.children.filter((c) => c.name === 'idex carriage' && c.userData['carriage'] === carriage).forEach((g: Object3D) =>
      g.traverse((o) => {
        const m = o as Mesh
        if (m.isMesh && m.name !== 'shadow' && m.name !== 'ring') box.union(new Box3().setFromObject(m))
      }),
    )
    return box
  }

  it('draws two carriages of the family head on one rail, never the Bambu H2 head', () => {
    const rig = new ToolheadRig()
    rig.setModel('snapmaker-module')
    rig.setSpec(j1())
    const names: string[] = []
    rig.root.traverse((o) => names.push(o.name))
    expect(names.filter((n) => n === 'idex carriage')).toHaveLength(2)
    expect(names).toContain('idex rail')
    // The H2 head's parts: the brushed cover, the display and the hot plate.
    for (const h2 of ['cover', 'display', 'chip']) expect(names).not.toContain(h2)
  })

  it('places the printing carriage at the move and parks the other at its end', () => {
    const spec = j1()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    rig.place(100, 60, 2, 1, null, null)
    const head = rig.root.getObjectByName('nozzle')!
    const xs = head.children.filter((c) => c.name === 'idex carriage').map((c) => c.position.x)
    expect(xs).toEqual([-50, 100])
    expect(head.position.y).toBe(60)
  })

  it('keeps the two heads apart through a whole change', () => {
    const spec = j1()
    const rig = new ToolheadRig()
    rig.setSpec(spec)
    const seq = changeSequence(spec, 0, 1, [300, 100, 5], [20, 100, 5], 1)
    for (let t = 0; t <= seq.duration; t += 0.02) {
      const pose = poseAt(seq, t)
      rig.place(pose.x, pose.y, pose.z, 1, pose, null)
      const a = solids(rig, 0)
      const b = solids(rig, 1)
      expect(a.max.x).toBeLessThan(b.min.x)
    }
  })
})
