// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The machine's fixed parts in Preview: the rack, dock, switch bay, chute and wiper show with playback stopped,
// "Show toolhead" hides only the moving head, and the fixtures still follow the print with the head hidden.
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { Box3, Vector3, type Mesh, type Object3D } from 'three'
import { Toolpaths } from '../src/toolpaths'
import { purgeGrams, type PurgePlan } from '../src/purge'
import { toolChangerSpec, type ToolChangerSpec } from '../src/toolchanger'
import { buildPreview, type Seg } from './sxpv-fixture'
import { SWAP_PRINTERS } from './swap-printers'

const bed = (w: number, d: number) => ({ widthMm: w, depthMm: d, heightMm: 300 })
const PRINTERS: { name: string; spec: () => ToolChangerSpec; parts: string[] }[] = [
  {
    name: 'Bambu Lab H2D',
    spec: () => toolChangerSpec('bambu-h2d', { nozzle_diameter: ['0.4', '0.4'], filament_map: ['1', '1'], machine_switch_extruder_time: '5.6', machine_load_filament_time: '26', machine_unload_filament_time: '26' }, bed(350, 320), 2)!,
    parts: ['chute', 'wiper'],
  },
  {
    name: 'Bambu Lab H2C',
    spec: () => toolChangerSpec('bambu-h2c', { nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'], machine_switch_extruder_time: '5', machine_load_filament_time: '15', machine_unload_filament_time: '15' }, bed(330, 320), 2)!,
    parts: ['rack', 'chute', 'wiper'],
  },
  { name: 'Snapmaker U1', spec: () => toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5' }, bed(270, 270), 4)!, parts: ['dock'] },
  { name: 'Prusa XL', spec: () => toolChangerSpec('prusa-xl-5-toolhead', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4', '0.4'] }, bed(360, 360), 5)!, parts: ['dock'] },
  ...SWAP_PRINTERS.map((p) => ({ ...p, parts: ['chute', 'wiper'] })),
  {
    name: 'UltiMaker S3',
    spec: () => toolChangerSpec('ultimaker-s3', { nozzle_diameter: [0.4, 0.4], extruder_offset: [[0, 0], [22, 0]], toolchange_park_position: [[180, 180], [180, 180]] }, bed(230, 190), 2)!,
    parts: ['switch bay'],
  },
  {
    name: 'UltiMaker S5',
    spec: () => toolChangerSpec('ultimaker-s5', { nozzle_diameter: [0.4, 0.4], extruder_offset: [[0, 0], [22, 0]], toolchange_park_position: [[330, 237], [330, 219]] }, bed(330, 240), 2)!,
    parts: ['switch bay'],
  },
]

const seg = (x: number, tool: number): Seg => ({ a: [x, 50], b: [x + 10, 50], feature: FEATURE.outerWall, tool })
// Three layers: tool 0, then a change to tool 1 at segment 4, then tool 1.
const preview = buildPreview([
  [seg(40, 0), seg(60, 0), seg(80, 0)],
  [seg(40, 0), seg(60, 1), seg(80, 1)],
  [seg(40, 1), seg(60, 1), seg(80, 1)],
])
const CHANGE = 4

/** True when `o` and every parent up to `stop` are visible. */
function shown(o: Object3D, stop: Object3D): boolean {
  for (let p: Object3D | null = o; p && p !== stop.parent; p = p.parent) if (!p.visible) return false
  return true
}

function rig(spec: ToolChangerSpec): Toolpaths {
  const t = new Toolpaths()
  t.set(preview)
  t.setToolChanger(spec)
  return t
}

const part = (t: Toolpaths, name: string) => t.root.getObjectByName(name)!
const head = (t: Toolpaths) => part(t, 'nozzle')
const parked = (t: Toolpaths, dock: string) =>
  part(t, dock)
    .children.filter((c) => c.userData.slot !== undefined)
    .map((c) => c.visible)

describe('machine fixtures in Preview', () => {
  for (const p of PRINTERS) {
    it(`${p.name}: ${p.parts.join(', ')} show with playback stopped, the moving head does not`, () => {
      const t = rig(p.spec())
      // The whole print, nothing scrubbed: no head, but the machine's fixed parts.
      for (const name of p.parts) expect(shown(part(t, name), t.root), name).toBe(true)
      expect(shown(head(t), t.root)).toBe(false)
      // Scrubbing shows the head as well; the fixtures stay.
      t.setRange(0, 1, 1)
      expect(shown(head(t), t.root)).toBe(true)
      for (const name of p.parts) expect(shown(part(t, name), t.root), name).toBe(true)
    })

    it(`${p.name}: "Show toolhead" off hides only the moving head`, () => {
      const t = rig(p.spec())
      t.setRange(0, 1, 1)
      t.setShowToolhead(false)
      expect(shown(head(t), t.root)).toBe(false)
      for (const name of p.parts) expect(shown(part(t, name), t.root), name).toBe(true)
      t.setShowToolhead(true)
      expect(shown(head(t), t.root)).toBe(true)
    })
  }

  it('keeps every chute off the bed, at the machine\'s own place', () => {
    const where: Record<string, [number, number]> = { 'bambu-a1': [-48.2, 128], 'bambu-a1-mini': [-13.5, 90], 'bambu-x1-carbon': [54, 265], 'bambu-p1s': [54, 265], 'bambu-h2s': [95.5, 336] }
    for (const p of SWAP_PRINTERS) {
      const spec = p.spec()
      expect(spec.kind).toBe('filament-swap')
      if (where[p.id]) expect([spec.chute!.x, spec.chute!.y], p.name).toEqual(where[p.id])
      const t = rig(spec)
      t.root.updateMatrixWorld(true)
      const { widthMm: w, depthMm: d } = spec.bed
      part(t, 'chute').traverse((o) => {
        if (!(o as Mesh).isMesh) return
        const b = new Box3().setFromObject(o)
        // Clear of the plate's area: beside it in x, or behind it in y.
        expect(b.max.x <= 0 || b.min.x >= w || b.min.y >= d || b.max.y <= 0, `${p.name}: ${o.name}`).toBe(true)
      })
    }
  })

  it('the A1 chute stands still on the frame while the head moves in x, y and z', () => {
    for (const id of ['bambu-a1', 'bambu-a1-mini']) {
      const spec = SWAP_PRINTERS.find((p) => p.id === id)!.spec()
      const t = new Toolpaths()
      // the head runs across the bed in y and climbs a layer at a time
      t.set(buildPreview([0, 1, 2].map((l) => [10, 60, 110].map((y): Seg => ({ a: [30 + l * 20, y], b: [40 + l * 20, y + 40], feature: FEATURE.outerWall, tool: 0 })))))
      t.setToolChanger(spec)
      const seen = new Set<string>()
      for (const [layer, cut] of [[0, 1], [0, 2], [1, 1], [1, 3], [2, 2], [2, 3]] as const) {
        t.setRange(0, layer, cut)
        t.root.updateMatrixWorld(true)
        const p = part(t, 'chute').getWorldPosition(new Vector3())
        seen.add(`${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)}`)
      }
      expect([...seen], id).toEqual([`${spec.chute!.x.toFixed(3)} ${spec.chute!.y.toFixed(3)} 0.000`])
    }
  })

  it('the P2S writes no chute position, so it has no fixtures', () => {
    expect(toolChangerSpec('bambu-p2s', { nozzle_diameter: ['0.4'] }, bed(256, 256), 2)).toBeNull()
  })

  it('shows nothing for a printer with one nozzle and no tool changer, until the head is scrubbed', () => {
    const t = new Toolpaths()
    t.set(preview)
    expect(shown(head(t), t.root)).toBe(false)
    expect(part(t, 'changer').children).toHaveLength(0)
    t.setRange(0, 0, 2)
    expect(shown(head(t), t.root)).toBe(true)
    t.setShowToolhead(false)
    expect(shown(head(t), t.root)).toBe(false)
  })

  it('a ghost preview draws no fixtures', () => {
    const t = new Toolpaths(true)
    t.set(preview)
    t.setToolChanger(PRINTERS[2]!.spec())
    expect(shown(part(t, 'dock'), t.root)).toBe(false)
  })
})

describe('fixtures follow the print with the head hidden', () => {
  it('the U1 dock shows which toolheads are parked, before and after a change', () => {
    for (const on of [true, false]) {
      const t = rig(PRINTERS[2]!.spec())
      t.setShowToolhead(on)
      t.setRange(0, 0, 2)
      expect(parked(t, 'dock')).toEqual([false, true, true, true])
      t.setRange(0, 1, 3)
      expect(parked(t, 'dock')).toEqual([true, false, true, true])
      // Playback stopped on the whole print: the dock as the print ends.
      t.setRange(0, 2, null)
      expect(parked(t, 'dock')).toEqual([true, false, true, true])
    }
  })

  it('the H2D purge blob grows at the chute during a change with the head hidden', () => {
    const plan = (volume: number): PurgePlan => {
      const e = volume / (Math.PI * 0.875 * 0.875)
      return { segment: CHANGE, e, volume, grams: purgeGrams(volume, 1.24), steps: [{ e: e * 0.3, seconds: 4 }, { e: e * 0.7, seconds: 12 }], from: 0, to: 1 }
    }
    const frames = (on: boolean) => {
      const t = rig(PRINTERS[0]!.spec())
      t.setToolColors(['#e07a2e', '#3e6fc0'])
      t.setPurges([plan(420)])
      t.setShowToolhead(on)
      t.setRange(0, 1, 1)
      const blob = part(t, 'blob')
      const out: { blob: boolean; head: boolean; z: number }[] = []
      for (let s = 0; s <= 90; s += 0.5) {
        t.setToolChange({ segment: CHANGE, seconds: s, fixed: 52 })
        out.push({ blob: shown(blob, t.root), head: shown(head(t), t.root), z: blob.position.z })
      }
      return out
    }
    const hidden = frames(false)
    expect(hidden.some((f) => f.blob)).toBe(true)
    expect(hidden.some((f) => f.head)).toBe(false)
    // The blob plays exactly as it does with the head shown.
    expect(hidden.map((f) => [f.blob, f.z])).toEqual(frames(true).map((f) => [f.blob, f.z]))
  })
})
