// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The purge at the chute: the flush read from the change G-code, its volume and weight, the blob's volume and
// its state as a pure function of the change's clock, and the blob, chute, head and rack never meeting.
import { describe, expect, it } from 'vitest'
import { Box3, type Mesh, type Object3D } from 'three'
import { CHUTE, PurgeRig, blobAt, blobShape, flushOf, flushedShare, meshVolume, purgeFromTools, purgeGrams, purgeVolume, purgeWindow, totalSeconds, type PurgePlan } from '../src/purge'
import { changeSequence, poseAt, toolChangerSpec, type ToolChangerSpec, type V3 } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'
import { headFor } from '../src/heads'
import { SWAP_PRINTERS } from './swap-printers'

// The H2D with both filaments on its left nozzle: every change is a filament change at the chute.
const h2d = () =>
  toolChangerSpec(
    'bambu-h2d',
    { nozzle_diameter: ['0.4', '0.4'], filament_map: ['1', '1'], machine_switch_extruder_time: '5.6', machine_load_filament_time: '26', machine_unload_filament_time: '26', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
    { widthMm: 350, depthMm: 320, heightMm: 325 },
    2,
  )!
const h2c = (tools = 3) =>
  toolChangerSpec(
    'bambu-h2c',
    { nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'], machine_switch_extruder_time: '5', machine_load_filament_time: '15', machine_unload_filament_time: '15', travel_speed: '500', machine_max_acceleration_travel: ['9000'] },
    { widthMm: 330, depthMm: 320, heightMm: 325 },
    tools,
  )!

// The H2D change G-code as the engine renders it (Bambu Studio's template, flush_length 166.3 mm): the firmware
// flushes, the `;VG1` lines stand for it.
const H2D_CHANGE = `M620 S1A
M204 S9000
G1 Z53.2 F1200
M620.10 A0 F359.2 L166.3 H0.4 T240 P220 S1
M620.10 A1 F359.2 L166.3 H0.4 T240 P220 S1
M628 S1
M620.11 S1 L0 I0 R10 D8 E-18 F359
M629
T1
;deretract
;VG1 E4 F524
;VG1 E4 F262

; VFLUSH_START
;VG1 E41.5 F524
;VG1 E124.8 F524
SYNC T10
; VFLUSH_END

M400
M83
G1 Y295 F30000
G1 Y265 F18000
M621 S1A`

// The X1 change G-code with two flush steps: the printer extrudes them itself, at the chute.
const X1_CHANGE = `M620 S1A
T1
G92 E0
M83
; FLUSH_START
M400
M109 S240
G1 E23.7 F523 ; do not need pulsatile flushing for start part
G1 E0.5 F50
G1 E5.8 F523
; FLUSH_END
G1 E-2 F1800
G1 E2 F300
G91
G1 X3 F12000; move aside to extrude
G90
M83
; FLUSH_START
G1 E10 F523
G1 E1 F50
; FLUSH_END
M621 S1A`

const plan = (volume: number, segment = 7): PurgePlan => {
  const e = volume / (Math.PI * 0.875 * 0.875)
  return { segment, e, volume, grams: purgeGrams(volume, 1.24), steps: [{ e: e * 0.3, seconds: 4 }, { e: e * 0.7, seconds: 12 }], from: 0, to: 1 }
}

describe('flush in the change G-code', () => {
  it('reads the virtual moves a Bambu H2 change writes for the firmware flush, not the deretract', () => {
    const f = flushOf(H2D_CHANGE.split('\n'))!
    expect(f.source).toBe('virtual')
    expect(f.e).toBeCloseTo(166.3, 6)
    expect(f.seconds).toBeCloseTo((166.3 / 524) * 60, 6)
  })

  it('reads the extrusion between FLUSH_START and FLUSH_END on the X1, P1 and A1, and nothing outside', () => {
    const f = flushOf(X1_CHANGE.split('\n'))!
    expect(f.source).toBe('moves')
    expect(f.e).toBeCloseTo(23.7 + 0.5 + 5.8 + 10 + 1, 6)
    expect(f.seconds).toBeCloseTo(((23.7 + 5.8 + 10) / 523) * 60 + ((0.5 + 1) / 50) * 60, 6)
  })

  it('follows absolute extrusion through G92, and falls back to the length handed to the firmware', () => {
    const abs = flushOf(['M82', 'G92 E0', '; FLUSH_START', 'G1 E20 F600', 'G1 E30', '; FLUSH_END', 'G1 E25'])!
    expect(abs.e).toBeCloseTo(30, 6)
    expect(abs.seconds).toBeCloseTo(3, 6)
    const fw = flushOf(['M620.10 A0 F300 L80', 'M620.10 A1 F300 L120 H0.4', 'T1'])!
    expect(fw.source).toBe('firmware')
    expect(fw.e).toBe(120)
    expect(fw.seconds).toBeCloseTo(24, 6)
    expect(flushOf(['T1', 'G1 X10 E2 F1200'])).toBeNull()
  })

  it('turns filament length into volume and volume into grams', () => {
    expect(purgeVolume(100, 1.75)).toBeCloseTo(100 * Math.PI * 0.875 ** 2, 9)
    expect(purgeVolume(100, 2.85)).toBeCloseTo(637.94, 2)
    expect(purgeGrams(1000, 1.24)).toBeCloseTo(1.24, 12)
    expect(purgeGrams(purgeVolume(166.3, 1.75), 1.24)).toBeCloseTo(0.4960, 4)
  })

  it('starts each purge in the color the nozzle held: a filament change mixes, a rack hotend keeps its own', () => {
    expect(purgeFromTools(h2d(), 0, [{ from: 0, to: 1 }, { from: 1, to: 0 }])).toEqual([0, 1])
    const rack = h2c(3)
    expect(purgeFromTools(rack, 0, [{ from: 0, to: 1 }, { from: 1, to: 2 }])).toEqual([1, 2])
  })
})

describe('purge timing', () => {
  const spec = h2d()
  const seq = changeSequence(spec, 0, 1, [100, 100, 10], [110, 100, 10], 52)

  it('runs at the end of the load at the flush moves own pace, and the kick comes as the head leaves over the wiper', () => {
    const p = plan(400)
    const w = purgeWindow(seq, totalSeconds(p))!
    const load = seq.phases.filter((x) => x.name === 'load').pop()!
    const wipe = seq.phases.find((x) => x.name === 'wipe')!
    expect(w.end).toBeCloseTo(load.t0 + load.dwell, 9)
    expect(w.end - w.start).toBeCloseTo(16, 9)
    expect(w.kick).toBeCloseTo(wipe.t0, 9)
    // The first step goes at its own pace: 30 percent of the plastic in its 4 s.
    expect(flushedShare(p, w, w.start + 4)).toBeCloseTo(0.3, 9)
    expect(flushedShare(p, w, w.start + 10)).toBeCloseTo(0.3 + 0.7 * 0.5, 9)
    // A flush longer than the load is squeezed into it.
    const long = purgeWindow(seq, 1000)!
    expect(long.start).toBeCloseTo(load.t0, 9)
  })

  it('has no purge for a change without a stop at the chute', () => {
    const u1 = toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5' }, { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)!
    expect(purgeWindow(changeSequence(u1, 0, 1, [100, 100, 10], [110, 100, 10], 5), 10)).toBeNull()
  })
})

describe('the blob', () => {
  it('holds exactly the volume pushed out so far, small or large', () => {
    for (const v of [0.4, 3, 25, 120, 400, 900, 1600]) {
      const s = blobShape(v, 900, 3)
      expect(meshVolume(s.positions, s.index) / v).toBeCloseTo(1, 6)
      // It hangs from the nozzle tip: nothing above it.
      let top = -Infinity
      for (let i = 2; i < s.positions.length; i += 3) top = Math.max(top, s.positions[i]!)
      expect(top).toBeLessThanOrEqual(1e-9)
    }
  })

  it('is a pure function of the change clock: scrubbing back and forth lands on the same state and the same mesh', () => {
    const spec = h2d()
    const seq = changeSequence(spec, 0, 1, [100, 100, 10], [110, 100, 10], 52)
    const p = plan(500)
    const w = purgeWindow(seq, totalSeconds(p))!
    const times = Array.from({ length: 400 }, (_, i) => w.start - 1 + ((w.kick + 0.4 - w.start + 1) * i) / 399)
    const wiper = spec.chute!.y + CHUTE.wiper.y[1]
    const state = (t: number) => {
      const share = flushedShare(p, w, t)
      const shape = blobShape(p.volume * Math.max(share, 1e-6), p.volume, p.segment)
      return JSON.stringify(blobAt(seq, p, w, t, shape.front, wiper))
    }
    const forward = times.map(state)
    const backward = times.slice().reverse().map(state).reverse()
    expect(backward).toEqual(forward)
    // The volume only grows while the flush runs, and the blob is gone once it has dropped.
    let last = 0
    for (const t of times) {
      const st = blobAt(seq, p, w, t, 5, wiper)
      if (st.phase === 'growing') {
        expect(st.volume).toBeGreaterThanOrEqual(last)
        last = st.volume
      }
    }
    expect(blobAt(seq, p, w, w.kick + 0.4, 5, wiper).phase).toBe('none')
    // The rig draws the same mesh at the same moment whichever way it got there.
    const rig = new PurgeRig()
    rig.setSpec(spec)
    rig.setColors(['#e07a2e', '#3e6fc0'])
    rig.visible = true
    const blob = rig.root.getObjectByName('blob') as Mesh
    const snap = (t: number) => {
      rig.place(10, { seq, plan: p, seconds: t })
      rig.root.updateMatrixWorld(true)
      return { pos: Array.from(blob.geometry.getAttribute('position')!.array as Float32Array).slice(0, 600), col: Array.from(blob.geometry.getAttribute('color')!.array as Float32Array).slice(0, 600), m: blob.matrixWorld.elements.slice(), on: blob.visible }
    }
    const mid = (w.start + w.end) / 2
    const a = snap(mid)
    snap(w.end - 0.1)
    snap(w.start + 0.5)
    expect(snap(mid)).toEqual(a)
  })

  it('runs from the old color at the bottom to the new one at the nozzle', () => {
    const s = blobShape(600, 600, 0)
    // The bottom pole holds the first plastic out, the top pole the last.
    const n = s.order.length
    expect(s.order[n - 1]).toBe(0)
    expect(s.order[n - 2]).toBeCloseTo(1, 9)
  })
})

/** World boxes of the visible solid parts under `g`. */
function boxes(g: Object3D, stop: Object3D): { name: string; box: Box3 }[] {
  const out: { name: string; box: Box3 }[] = []
  const shown = (o: Object3D) => {
    for (let p: Object3D | null = o; p && p !== stop; p = p.parent) if (!p.visible) return false
    return true
  }
  g.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || !m.name || m.name === 'shadow' || !shown(m)) return
    out.push({ name: m.name, box: new Box3().setFromObject(m, true) })
  })
  return out
}

/** How far two boxes overlap on their least overlapping axis; 0 or less means they at most touch. */
function depth(a: Box3, b: Box3): number {
  return Math.min(Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y), Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z))
}

/** Plays a change with its purge and returns the worst overlap between the blob, the chute, the head and the rack. */
function sweep(spec: ToolChangerSpec, from: number, to: number, volume: number, fixed: number, history: [number, number][] = [], printerId = '') {
  const head = new ToolheadRig()
  head.setModel(headFor(printerId))
  head.setSpec(spec)
  head.setColors(['#e07a2e', '#3e6fc0', '#00ff00'])
  head.visible = true
  const purge = new PurgeRig()
  purge.setSpec(spec)
  purge.setColors(['#e07a2e', '#3e6fc0', '#00ff00'])
  purge.visible = true
  const at: V3 = [spec.bed.widthMm / 2, spec.bed.depthMm - 40, 12]
  const seq = changeSequence(spec, from, to, at, [at[0] + 10, at[1], 12], fixed, history)
  const p = plan(volume)
  const w = purgeWindow(seq, totalSeconds(p))!
  const nozzle = head.root.getObjectByName('nozzle')!
  const changer = head.root.getObjectByName('changer')!
  const blob = purge.root.getObjectByName('blob')!
  const chute = purge.root.getObjectByName('chute')!
  let worst = { depth: -Infinity, at: '' }
  let shownBlob = 0
  let fell = 0
  const check = (aa: { name: string; box: Box3 }[], bb: { name: string; box: Box3 }[], what: string, t: number, phase: string) => {
    for (const a of aa)
      for (const b of bb) {
        const d = depth(a.box, b.box)
        if (d > worst.depth) worst = { depth: d, at: `${phase} at ${t.toFixed(3)} s: ${what} ${a.name} into ${b.name}` }
      }
  }
  // Coarse over the whole change, fine around the kick and the fall.
  const times: number[] = []
  for (let t = 0; t <= seq.duration; t += seq.duration / 800) times.push(t)
  for (let t = w.kick - 0.02; t <= w.kick + 0.3; t += 0.0015) times.push(t)
  for (const t of times) {
    const pose = poseAt(seq, t)
    head.place(pose.x, pose.y, pose.z, to, pose, pose.slots)
    const st = purge.place(pose.z + 0.05, { seq, plan: p, seconds: t }, pose.y)
    head.root.updateMatrixWorld(true)
    purge.root.updateMatrixWorld(true)
    const hb = boxes(nozzle, head.root)
    const fb = boxes(changer, head.root)
    const cb = boxes(chute, purge.root)
    const bb = blob.visible ? boxes(blob, purge.root) : []
    if (bb.length) shownBlob++
    if (st?.phase === 'falling') fell++
    check(hb, cb, 'head', t, pose.phase)
    check(bb, hb, 'blob', t, pose.phase)
    check(bb, cb, 'blob', t, pose.phase)
    check(bb, fb, 'blob', t, pose.phase)
    check(cb, fb, 'chute', t, pose.phase)
  }
  return { worst, shownBlob, fell }
}

// Each sweep poses the rigs some thousands of times: about 2 s a test alone, over 5 s beside other heavy work.
describe('purge geometry', () => {
  it('H2D: the blob grows on the nozzle, the wiper takes it and it drops down the chute without touching the head or the chute', () => {
    for (const v of [30, 420, 1100]) {
      const r = sweep(h2d(), 0, 1, v, 52)
      expect(r.worst.depth, r.worst.at).toBeLessThanOrEqual(0.01)
      expect(r.shownBlob).toBeGreaterThan(20)
      expect(r.fell).toBeGreaterThan(5)
    }
  }, 30_000)

  it('H2C: a hotend swap with its trip to the rack keeps the blob, the chute, the head and the rack apart', () => {
    for (const v of [60, 700]) {
      const r = sweep(h2c(3), 0, 1, v, 35)
      expect(r.worst.depth, r.worst.at).toBeLessThanOrEqual(0.01)
      expect(r.fell).toBeGreaterThan(5)
    }
  }, 30_000)

  for (const p of SWAP_PRINTERS)
    it(`${p.name}: the blob grows at the chute, the wiper takes it as the head leaves and it drops without touching the head or the chute`, () => {
      for (const v of [40, 600]) {
        const r = sweep(p.spec(), 0, 1, v, 50, [], p.id)
        expect(r.worst.depth, r.worst.at).toBeLessThanOrEqual(0.01)
        expect(r.shownBlob).toBeGreaterThan(20)
        expect(r.fell).toBeGreaterThan(5)
      }
    }, 30_000)
})
