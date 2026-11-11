// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab H3C in Preview: which printers get the PrintTool rack, the stock profile's values, the change it plays
// (to the rack at the front, park, pick, to the chute at the back, out by the change G-code's exit moves), the hotend
// each change of a real two filament slice goes to and how many changes it makes, that the head never runs into the
// rack or a parked PrintTool, and the head, PrintTools and rack it draws.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { Box3, type Mesh, type Object3D } from 'three'
import { ChangeClock, H3C_PITCH, SPARE, changeSequence, poseAt, toolChangerSpec, type ChangeSequence, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { changePoints } from '../src/toolpaths'
import { ToolheadRig } from '../src/toolhead'
import { buildPreview, type Seg } from './sxpv-fixture'

/** The H3C build volume (its machine profile): 330 x 320 x 325 mm. */
const BED = { widthMm: 330, depthMm: 320, heightMm: 325 }
/** The stock H3C machine and standard process settings as resolved (packages/profiles/resolved/bambu-lab.json). */
const model = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../profiles/resolved/bambu-lab.json', import.meta.url)), 'utf8')) as { models: Record<string, { base: string; machine: Record<string, unknown>; process: Record<string, Record<string, unknown>> }> }).models['bambu-h3c']!
const stock = { ...model.process[model.base], ...model.machine }
/** The app's settings for it: the schema's tool change time default (0) and one nozzle, plus the slice's hotend map. */
const h3c = (hotends?: number[]) => ({ ...stock, nozzle_diameter: ['0.4'], machine_tool_change_time: 0, ...(hotends ? { filament_nozzle_map: hotends } : {}) })
const spec = (tools: number, hotends?: number[]) => toolChangerSpec('bambu-h3c', h3c(hotends), BED, tools)!

const at: V3 = [120, 150, 10]
const resume: V3 = [200, 120, 10]

describe('which printers get the PrintTool rack (kindOf)', () => {
  it('gives the H3C the PrintTool rack, by its profile id and by one extruder with more than one hotend', () => {
    expect(spec(2).kind).toBe('printtool-rack')
    expect(toolChangerSpec('bambu-h3c', { nozzle_diameter: ['0.4'] }, BED, 2)?.kind).toBe('printtool-rack')
    expect(toolChangerSpec('some-printer', { nozzle_diameter: ['0.4'], extruder_max_nozzle_count: ['9'] }, BED, 2)?.kind).toBe('printtool-rack')
  })

  it('leaves the H2C rack, the H2D and the single nozzle printers as they were', () => {
    expect(toolChangerSpec('bambu-h2c', { nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'] }, BED, 2)?.kind).toBe('hotend-rack')
    expect(toolChangerSpec('bambu-h2d', { nozzle_diameter: ['0.4', '0.4'] }, BED, 2)?.kind).toBe('dual-nozzle')
    expect(toolChangerSpec('bambu-x1-carbon', { nozzle_diameter: ['0.4'] }, BED, 2)?.kind).toBe('filament-swap')
    expect(toolChangerSpec('bambu-x1-carbon', { nozzle_diameter: ['0.4'], extruder_max_nozzle_count: ['1'] }, BED, 2)?.kind).toBe('filament-swap')
  })
})

describe('the stock H3C', () => {
  it('has nine docks along the front, the 4 s hotend swap, the 3 mm lift over the print and the exit moves at Y 295 and 265', () => {
    const s = spec(2)
    const k = s.printTool!
    expect(k.x).toHaveLength(9)
    for (let i = 1; i < 9; i++) expect(k.x[i]! - k.x[i - 1]!).toBeCloseTo(H3C_PITCH)
    expect((k.x[0]! + k.x[8]!) / 2).toBeCloseTo(BED.widthMm / 2)
    expect(k.dockY).toBeLessThan(0)
    expect(k.clearY).toBeGreaterThan(k.dockY)
    // Hotend change 0, tool change 0 (the schema default), switch 4 s: the swap takes 4 s, as the engine counts it.
    expect(s.seconds.switch).toBe(4)
    expect(s.liftMm).toBe(3)
    expect(s.liftOverPrint).toBe(true)
    // The chute at the back right, past the bed; out by G387 Y295 (F60000) and Y265 (F18000).
    expect(s.chute!.x).toBeGreaterThan(BED.widthMm / 2)
    expect(s.chute!.y).toBeGreaterThan(BED.depthMm)
    expect(s.chute!.exitY).toEqual([295, 265])
    expect(k.exit.map((l) => l.speed)).toEqual([1000, 300])
  })

  it('puts each filament on the hotend the slice gave it, and with no map one hotend per filament', () => {
    expect(spec(3, [0, 0, 1]).extruderOf).toEqual([0, 0, 1])
    expect(spec(3, [4, 7, 12]).extruderOf).toEqual([4, 7, 8])
    expect(spec(3).extruderOf).toEqual([0, 1, 2])
  })
})

describe('the change', () => {
  it('runs to the rack, parks, picks, goes to the chute and leaves by the exit moves, the rack down only for the swap', () => {
    const s = spec(2)
    const k = s.printTool!
    const ch = s.chute!
    const seq = changeSequence(s, 0, 1, at, resume, 4)
    expect(seq.phases.map((p) => p.name)).toEqual(['lift', 'to rack', 'insert', 'release', 'back out', 'to next', 'insert', 'latch', 'extract', 'to chute', 'load', 'wipe', 'exit', 'return', 'lower'])
    const up = 10 + 3
    const [a, c] = [k.x[0]!, k.x[1]!]
    expect(seq.phases.map((p) => p.to)).toEqual([
      [at[0], at[1], up],
      [a, k.clearY, up],
      [a, k.dockY, up],
      [a, k.dockY, up],
      [a, k.clearY, up],
      [c, k.clearY, up],
      [c, k.dockY, up],
      [c, k.dockY, up],
      [c, k.clearY, up],
      [ch.x, ch.y, up],
      [ch.x, ch.y, up],
      [ch.x, 295, up],
      [ch.x, 265, up],
      [resume[0], resume[1], up],
      resume,
    ])
    expect(seq.phases.map((p) => p.carried)).toEqual([0, 0, 0, null, null, null, null, 1, 1, 1, 1, 1, 1, 1, 1])
    // The rack is raised while the print runs, down from the trip to the rack to the trip to the chute.
    expect(seq.phases.map((p) => p.row)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
    expect(poseAt(seq, 0).row).toBe(1)
    const release = seq.phases.find((p) => p.name === 'release')!
    expect(poseAt(seq, release.t0 + 0.01).row).toBe(0)
    expect(poseAt(seq, seq.duration).row).toBe(1)
    // The firmware's part, from the trip to the rack to the chute, takes the profile's 4 s.
    const fw = (q: ChangeSequence) => q.phases.slice(1, 11).reduce((t, p) => t + p.move + p.dwell, 0)
    expect(fw(seq)).toBeCloseTo(4, 6)
    // A change time shorter than the moves: the prime keeps its shortest 0.3 s and the change takes longer.
    const short = changeSequence(spec(9), 8, 0, [320, 310, 10], resume, 1)
    expect(short.phases.find((p) => p.name === 'load')!.dwell).toBeCloseTo(0.3, 6)
    expect(fw(short)).toBeGreaterThan(1)
    // Spares hang in the docks the print does not use; the head's dock is empty.
    expect(seq.slotsBefore).toEqual([-1, 1, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE])
    expect(seq.slotsAfter).toEqual([0, -1, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE, SPARE])
  })

  it('swaps filament at the chute, with no rack visit, when two filaments share a hotend', () => {
    const s = spec(2, [3, 3])
    const seq = changeSequence(s, 0, 1, at, resume, 43)
    const names = seq.phases.map((p) => p.name)
    expect(names).toEqual(['lift', 'to chute', 'cut', 'load', 'wipe', 'exit', 'return', 'lower'])
    expect(seq.phases.every((p) => p.to[1] >= 0)).toBe(true)
  })
})

/**
 * A real H3C slice (two 33 mm cubes on the stock 0.4 mm H3C, PETG in filament 1 and ABS in filament 3, a prime tower):
 * 165 layers, both filaments on every layer, 165 tool changes alternating between the two, each layer starting with
 * the filament the last one ended on. The slice's map puts filament 1 on hotend 0 and filament 3 on hotend 1 (the change
 * G-code's hotend ids for every change); filament 2 is not printed and stays on hotend 0. Tool bytes are 0-based.
 */
const REAL = { layers: 165, changes: 165, tools: [0, 2] as const, hotends: [0, 0, 1, 0, 0, 0, 0, 0] }

function realPreview() {
  const layers: Seg[][] = []
  let last: number = REAL.tools[0]
  for (let l = 0; l < REAL.layers; l++) {
    const other = last === REAL.tools[0] ? REAL.tools[1] : REAL.tools[0]
    layers.push([
      { a: [150, 160], b: [180, 160], feature: FEATURE.outerWall, tool: last },
      { a: [230, 160], b: [260, 160], feature: FEATURE.outerWall, tool: other },
    ])
    last = other
  }
  return buildPreview(layers)
}

describe('the real two filament slice', () => {
  it('plays every change of the slice, each swap on the hotend of the filament map', () => {
    const preview = realPreview()
    const points = changePoints(preview)
    expect(points).toHaveLength(REAL.changes)
    const s = spec(preview.toolCount, REAL.hotends)
    const k = s.printTool!
    const clock = new ChangeClock(s, Math.max(1, ...s.extruderOf) + 1)
    clock.change(REAL.tools[0])
    const history: [number, number][] = []
    const fixed: number[] = []
    for (const c of points) {
      const seq = changeSequence(s, c.from, c.to, at, resume, clock.change(c.to), history)
      fixed.push(seq.phases.find((p) => p.name === 'load')!.dwell)
      // The PrintTool parked is the one of the filament that printed; the one picked, the next filament's.
      const release = seq.phases.find((p) => p.name === 'release')!
      const latch = seq.phases.find((p) => p.name === 'latch')!
      expect(release.to[0]).toBe(k.x[REAL.hotends[c.from]!])
      expect(latch.to[0]).toBe(k.x[REAL.hotends[c.to]!])
      expect(latch.carried).toBe(c.to)
      expect(latch.state).toBe(c.to === 2 ? 1 : 0)
      history.push([c.from, c.to])
    }
    // The hotends alternate 1, 0, 1, ... as the slice's changes do.
    expect(points.map((c) => REAL.hotends[c.to])).toEqual(Array.from({ length: REAL.changes }, (_, i) => (i % 2 === 0 ? 1 : 0)))
    // The first visit to hotend 1 loads its filament (15 s) on top of the 4 s swap; every later swap is 4 s.
    const times = (() => {
      const c2 = new ChangeClock(s, 9)
      c2.change(0)
      return points.map((p) => c2.change(p.to))
    })()
    expect(times[0]).toBe(19)
    expect(new Set(times.slice(1))).toEqual(new Set([4]))
    expect(fixed.length).toBe(REAL.changes)
  })
})

/** World boxes of the visible meshes under `o`, each shrunk by 0.05 mm so faces that only touch do not count. */
function boxes(o: Object3D, skip: (m: Object3D) => boolean = () => false): { name: string; box: Box3 }[] {
  const out: { name: string; box: Box3 }[] = []
  o.updateMatrixWorld(true)
  const shown = (m: Object3D) => {
    for (let p: Object3D | null = m; p; p = p.parent) if (!p.visible && p.name !== 'toolhead') return false
    return true
  }
  o.traverse((m) => {
    if (!(m as Mesh).isMesh || !shown(m) || m.name === 'shadow' || skip(m)) return
    out.push({ name: m.name, box: new Box3().setFromObject(m).expandByScalar(-0.05) })
  })
  return out
}

describe('collisions and smooth motion', () => {
  const cases: [ToolChangerSpec, number, number][] = [
    [spec(2), 0, 1],
    [spec(2), 1, 0],
    [spec(9), 0, 8],
    [spec(9), 8, 3],
    [spec(9), 4, 5],
  ]

  it('never runs the head into the rack or a parked PrintTool, and never jumps', () => {
    for (const [s, from, to] of cases) {
      const k = s.printTool!
      const seq: ChangeSequence = changeSequence(s, from, to, at, resume, 4)
      const rig = new ToolheadRig()
      rig.setSpec(s)
      rig.visible = true
      const head = rig.root.getObjectByName('nozzle')!
      const fixed = rig.root.getObjectByName('changer')!
      let prev = poseAt(seq, 0)
      for (let i = 0; i * (1 / 120) <= seq.duration + 1e-9; i++) {
        const t = i / 120
        const p = poseAt(seq, t)
        // The profile's travel runs at up to 1400 mm/s: at most about 12 mm a frame.
        expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThan(12)
        prev = p
        if (i % 6 !== 0) continue
        rig.place(0, 0, 0, from, p, null)
        // The PrintTool at the dock the head works is the one it hands over or takes.
        const serving = p.y < k.clearY - 0.5 ? k.x.findIndex((x) => Math.abs(x - p.x) < 0.5) : -1
        const hb = boxes(head)
        const fb = boxes(fixed, (m) => {
          for (let q: Object3D | null = m; q; q = q.parent) if (q.userData.slot === serving && q.name === 'tool') return true
          return false
        })
        for (const h of hb) for (const f of fb) expect(h.box.intersectsBox(f.box), `${from}-${to} ${p.phase} t ${t.toFixed(3)}: head ${h.name} meets ${f.name}`).toBe(false)
        expect(p.y).toBeGreaterThanOrEqual(k.dockY - 1e-9)
        if (p.y < 0) expect(p.z).toBeCloseTo(10 + s.liftMm, 6)
      }
    }
  }, 60_000)
})

describe('the H3C drawing', () => {
  const names = (o: Object3D) => {
    const out: string[] = []
    o.traverse((c) => void out.push(c.name))
    return out
  }

  it('draws the H3C head, a PrintTool and a dock with its PrintTool for each hotend, never another changer', () => {
    const rig = new ToolheadRig()
    rig.setSpec(spec(2))
    rig.visible = true
    const n = names(rig.root)
    for (const own of ['h3c head', 'lock plate', 'cover', 'rack beam', 'rack top']) expect(n).toContain(own)
    expect(n.filter((x) => x === 'hanger')).toHaveLength(9)
    expect(n.filter((x) => x === 'tool')).toHaveLength(10)
    for (const other of ['smart head', 'coupling plate', 'frame bar', 'motor', 'lever', 'shuttle', 'holder', 'bay front']) expect(n).not.toContain(other)
  })

  it('shows the PrintTool in the head or in its dock as the change goes, and the rack raised away from it', () => {
    const s = spec(2)
    const k = s.printTool!
    const rig = new ToolheadRig()
    rig.setSpec(s)
    const seq = changeSequence(s, 0, 1, at, resume, 4)
    const shown = () => {
      const docks: boolean[] = []
      let carried = false
      for (const c of rig.root.getObjectByName('nozzle')!.children) if (c.name === 'tool') carried = c.visible
      rig.root.getObjectByName('dock')!.traverse((o) => void (o.name === 'tool' && docks.push(o.visible)))
      return { docks, carried, rackZ: rig.root.getObjectByName('dock')!.position.z }
    }
    const tAt = (name: string, f = 0.5) => {
      const p = seq.phases.find((q) => q.name === name)!
      return p.t0 + (p.move + p.dwell) * f
    }
    rig.place(100, 100, 10, 0, null, null)
    expect(shown()).toEqual({ docks: [false, true, true, true, true, true, true, true, true], carried: true, rackZ: k.rise })
    rig.place(0, 0, 0, 0, poseAt(seq, tAt('to next')), null)
    expect(shown()).toEqual({ docks: [true, true, true, true, true, true, true, true, true], carried: false, rackZ: 0 })
    rig.place(0, 0, 0, 0, poseAt(seq, tAt('extract')), null)
    expect(shown()).toEqual({ docks: [true, false, true, true, true, true, true, true, true], carried: true, rackZ: 0 })
    rig.place(0, 0, 0, 0, poseAt(seq, seq.duration), null)
    expect(shown().rackZ).toBe(k.rise)
  })

  it('shows the PrintTool in play in its filament color with a light edge, parked ones in steel', () => {
    const s = spec(2)
    const rig = new ToolheadRig()
    rig.setSpec(s)
    rig.setColors(['#f28c28', '#2ab7ca'])
    const seq = changeSequence(s, 0, 1, at, resume, 4)
    const look = () => {
      const head = rig.root.getObjectByName('nozzle')!.children.find((c) => c.name === 'tool')!
      const color = (o: Object3D) => ((o.getObjectByName('nozzle') as Mesh).material as { color?: { getHexString(): string } }).color?.getHexString()
      const docks: { lit: boolean; color: string | undefined }[] = []
      rig.root.getObjectByName('dock')!.traverse((o) => void (o.name === 'tool' && docks.push({ lit: o.getObjectByName('edge')!.visible, color: color(o) })))
      return { head: { lit: head.getObjectByName('edge')!.visible, color: color(head) }, docks }
    }
    const steelHex = look().docks[2]!.color
    rig.place(100, 100, 10, 0, null, null)
    let l = look()
    expect(l.head.lit).toBe(true)
    expect(l.head.color).not.toBe(steelHex)
    expect(l.docks.every((d) => !d.lit && d.color === steelHex)).toBe(true)
    // Just released into dock 0: that PrintTool is lit and in its color while the head is in front of it.
    const release = seq.phases.find((p) => p.name === 'release')!
    rig.place(0, 0, 0, 0, poseAt(seq, release.t0 + release.dwell * 0.9), null)
    l = look()
    expect(l.docks[0]!.lit).toBe(true)
    expect(l.docks[0]!.color).not.toBe(steelHex)
    expect(l.docks.slice(1).every((d) => !d.lit && d.color === steelHex)).toBe(true)
    // Back out at the clearance line and on: dock 0 goes back to steel.
    rig.place(0, 0, 0, 0, poseAt(seq, seq.phases.find((p) => p.name === 'to next')!.t0 + 0.01), null)
    expect(look().docks[0]).toEqual({ lit: false, color: steelHex })
  })
})
