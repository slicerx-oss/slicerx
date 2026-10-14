// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { addMark, customGcodeProblem, layerGcodeByHeight, marksFor, nextSlot, removeMark, setMarkSlot } from '../src/plate/layer-marks'
import { layerAtPoint, layerOf, pinLanes, pinLayout } from '../src/workspaces/preview/layer-track'
import { get, set, type PlateEntry } from '../src/state/store'

describe('layer marks', () => {
  beforeEach(() => set({ layerMarks: {}, activePlate: 'plate-1' }))

  it('refuses G-code that changes the printer or overheats it, and accepts plain text', () => {
    expect(customGcodeProblem('')).toContain('Enter')
    expect(customGcodeProblem('M500')).toContain('printer memory')
    expect(customGcodeProblem('SAVE_CONFIG')).toContain('configuration')
    expect(customGcodeProblem('M104 S400')).toContain('hotter')
    expect(customGcodeProblem('M140 S140')).toContain('hotter')
    expect(customGcodeProblem('M84')).toContain('motors')
    expect(customGcodeProblem('M117 Change the plate\nG4 P1000')).toBeNull()
  })

  it('keeps one mark per height, sorted, and sends them by height', () => {
    addMark(0.6, 'pause')
    addMark(0.2, 'color_change')
    addMark(0.6, 'custom', 'M117 hi')
    const m = marksFor()
    expect(m.map((x) => `${x.z}:${x.kind}`)).toEqual(['0.2:color_change', '0.6:custom'])
    expect(layerGcodeByHeight(m)).toEqual([{ zMm: 0.2, kind: 'color_change' }, { zMm: 0.6, kind: 'custom', gcode: 'M117 hi' }])
    removeMark(m[0]!.id)
    expect(marksFor()).toHaveLength(1)
    expect(() => addMark(0.4, 'custom', 'M500')).toThrow('printer memory')
    expect(get().layerMarks['plate-1']).toHaveLength(1)
  })
})

describe('the filament a color change goes to', () => {
  beforeEach(() => set({ layerMarks: {}, activePlate: 'plate-1' }))

  it('defaults to the slot after the last color change below, and keeps the G-code the same', () => {
    expect(nextSlot(2, [], 4)).toBe(2)
    const a = addMark(2, 'color_change', undefined, undefined, 2)!
    expect(nextSlot(4, marksFor(), 4)).toBe(3)
    expect(nextSlot(1, marksFor(), 4)).toBe(2)
    addMark(4, 'color_change', undefined, undefined, 4)
    expect(nextSlot(6, marksFor(), 4)).toBe(1)
    setMarkSlot(a.id, 3)
    expect(marksFor().find((m) => m.id === a.id)?.slot).toBe(3)
    expect(layerGcodeByHeight(marksFor())).toEqual([{ zMm: 2, kind: 'color_change' }, { zMm: 4, kind: 'color_change' }])
    // a pause takes no slot
    expect(addMark(6, 'pause', undefined, undefined, 2)?.slot).toBeUndefined()
  })
})

describe('layer marks in a project file', () => {
  it('are written as Orca lays them out and read back, with custom text kept', async () => {
    const { writeProject, projectFiles } = await import('../src/export/threemf')
    const { readProject } = await import('../src/export/import3mf')
    const { boxMesh } = await import('../src/plate/mesh-ops')
    const { compose } = await import('../src/plate/transform')
    const entry: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    const input = {
      plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' as const } }],
      bed: { widthMm: 256, depthMm: 256 },
      settings: {},
      layerMarks: { 0: [{ z: 2, kind: 'pause' as const }, { z: 4.2, kind: 'color_change' as const, slot: 3 }, { z: 6, kind: 'custom' as const, gcode: 'M117 hi <there>' }] },
    }
    const xml = String(projectFiles(input).find((f) => f.name === 'Metadata/custom_gcode_per_layer.xml')!.data)
    expect(xml).toContain('<plate_info id="1"/>')
    expect(xml).toContain('top_z="2" type="1"')
    expect(xml).toContain('top_z="4.2" type="0" extruder="3"')
    expect(xml).toContain('top_z="6" type="4"')
    const read = await readProject(writeProject(input), input.bed)
    expect(read.plates[0]!.marks).toEqual([{ z: 2, kind: 'pause' }, { z: 4.2, kind: 'color_change', slot: 3 }, { z: 6, kind: 'custom', gcode: 'M117 hi <there>' }])
  })

  it('a project without marks has no marks file', async () => {
    const { projectFiles } = await import('../src/export/threemf')
    const files = projectFiles({ plates: [], bed: { widthMm: 256, depthMm: 256 }, settings: {} })
    expect(files.some((f) => f.name === 'Metadata/custom_gcode_per_layer.xml')).toBe(false)
  })
})

describe('pin lanes', () => {
  it('keeps pins in one lane while they are apart, and steps crowded ones right', () => {
    // a 200 px track: 0.1 and 0.5 are 80 px apart, 0.5 and 0.55 only 10 px
    expect(pinLanes([0.1, 0.5, 0.55], 200)).toEqual([0, 0, 1])
    // three within one hit area take three lanes; a fourth further down goes back to the first
    expect(pinLanes([0.3, 0.31, 0.32, 0.6], 200)).toEqual([0, 1, 2, 0])
    // order on the track decides, not the order of the marks
    expect(pinLanes([0.55, 0.5], 200)).toEqual([1, 0])
  })
})

describe('pin heads clear of other stems', () => {
  it('moves a crowded head right of its layer, so no stem runs through a head in another lane', () => {
    // 60, 62, 64 and 120 px: the second and third step up and right, 17 px clear of each head under them
    expect(pinLayout([0.3, 0.31, 0.32, 0.6], 200)).toEqual([
      { lane: 0, off: 0, elbow: 7 },
      // each moved head in the crowd steps back lower than the one before, so the feet nest
      { lane: 1, off: 15, elbow: 7 },
      { lane: 2, off: 30, elbow: 4.5 },
      { lane: 0, off: 0, elbow: 7 },
    ])
  })
  it('never crosses two stems or runs a stem through a head', () => {
    // each stem as 2 px boxes in px over the track's center: up from the track at the layer, along at the elbow, up to
    // the head; a head is 16 px square on top of its stem
    type Box = [number, number, number, number]
    const overlap = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
    const sets = [[19, 20, 21, 149], [4, 19, 20, 21, 119, 249], [10, 11, 12, 13], [0, 3, 30, 31, 33, 300], [50, 52, 60, 70]]
    for (const px of [200, 300, 449, 700])
      for (const layers of sets) {
        const shares = layers.map((l) => l / 303)
        const parts = pinLayout(shares, px).map((p, i) => {
          const at = shares[i]! * px
          const hx = at + p.off
          const foot = 11 + p.lane * 18
          const stem: Box[] = [[hx - 1, p.elbow, hx + 1, foot], [at - 1, 0, at + 1, p.elbow + 2]]
          if (p.off) stem.push([at - 1, p.elbow, hx + 1, p.elbow + 2])
          return { at, head: [hx - 8, foot, hx + 8, foot + 16] as Box, stem }
        })
        for (const [i, a] of parts.entries())
          for (const [j, b] of parts.entries()) {
            if (i === j) continue
            // layers closer than the 2 px line share it where they meet the track, under the elbows
            const shared = Math.abs(a.at - b.at) < 2
            for (const s of a.stem) {
              expect(overlap(s, b.head), `${layers} at ${px}: stem ${i} through head ${j}`).toBe(false)
              for (const t of b.stem) if (!(shared && Math.min(s[3], t[3]) <= 9.5)) expect(overlap(s, t), `${layers} at ${px}: stems ${i} and ${j}`).toBe(false)
            }
          }
      }
  })
  it('settles on any track length', () => {
    // a head pushed to exactly the gap once counted as too near again and moved forever
    for (let px = 1; px < 600; px += 0.37) expect(pinLayout([19, 20, 21, 149].map((l) => l / 303), px)).toHaveLength(4)
  })
  it('keeps heads in one lane 26 px apart when every lane is taken', () => {
    const at = [0.3, 0.31, 0.32, 0.33].map((s) => s * 200)
    const pins = pinLayout([0.3, 0.31, 0.32, 0.33], 200)
    const x = pins.map((p, i) => at[i]! + p.off)
    expect(pins[3]!.lane).toBe(0)
    expect(x[3]! - x[0]!).toBeGreaterThanOrEqual(26)
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.abs(x[i]! - x[j]!)).toBeGreaterThanOrEqual(pins[i]!.lane === pins[j]!.lane ? 26 : 17)
  })
})

describe('pin lanes when every lane is taken', () => {
  it('puts the next pin in the lane whose last pin is furthest back', () => {
    // four pins 2 px apart: three lanes, then the fourth back in the first
    expect(pinLanes([0.3, 0.31, 0.32, 0.33], 200)).toEqual([0, 1, 2, 0])
    // with two lanes the third goes back to the first
    expect(pinLanes([0.3, 0.31, 0.32], 200, 2)).toEqual([0, 1, 0])
  })
})

describe('a mark lands on a layer slot', () => {
  // a 213 px track: 200 px between the thumb's centers at the first and last layer
  const track = { left: 100, width: 213 }
  it('picks the nearest layer to the pointer, never one between two', () => {
    expect(layerAtPoint(106.5, track, 11)).toBe(1)
    expect(layerAtPoint(306.5, track, 11)).toBe(11)
    // 20 px per layer: 115 px from the first center is nearer layer 7 (120) than layer 6 (100)
    expect(layerAtPoint(106.5 + 115, track, 11)).toBe(7)
    expect(layerAtPoint(106.5 + 109, track, 11)).toBe(6)
    // past either end, the end layer
    expect(layerAtPoint(0, track, 11)).toBe(1)
    expect(layerAtPoint(999, track, 11)).toBe(11)
    expect(layerAtPoint(200, track, 1)).toBe(1)
  })
  it('a mark between two layer tops shows on the layer above it', () => {
    const z = [0.2, 0.4, 0.6]
    expect(layerOf({ z: 0.4 }, z)).toBe(2)
    expect(layerOf({ z: 0.45 }, z)).toBe(3)
    expect(layerOf({ z: 9 }, z)).toBe(3)
  })
})

describe('pin lanes before the track is measured', () => {
  it('keeps every pin in the first lane', () => {
    expect(pinLanes([0.1, 0.5, 0.55], 0)).toEqual([0, 0, 0])
  })
})
