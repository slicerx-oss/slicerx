// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { addMark, customGcodeProblem, layerGcodeByHeight, marksFor, nextSlot, removeMark, setMarkSlot } from '../src/plate/layer-marks'
import { layerAtPoint, layerOf, markName, pinLanes, pinLayout, pinsAt, TOUCH_R, type PinHead } from '../src/workspaces/preview/layer-track'
import { inputsChanged } from '../src/state/slice-inputs'
import { startAutoSlice } from '../src/state/auto-slice'
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
      { lane: 0, off: 0, elbow: 7, into: -1 },
      // each moved head in the crowd steps back lower than the one before, so the feet nest
      { lane: 1, off: 15, elbow: 7, into: -1 },
      { lane: 2, off: 30, elbow: 4.5, into: -1 },
      { lane: 0, off: 0, elbow: 7, into: -1 },
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
        const parts = pinLayout(shares, px).flatMap((p, i) => {
          // a pin held by another head draws nothing of its own
          if (p.into >= 0) return []
          const at = shares[i]! * px
          const hx = at + p.off
          const foot = 11 + p.lane * 18
          const stem: Box[] = [[hx - 1, p.elbow, hx + 1, foot], [at - 1, 0, at + 1, p.elbow + 2]]
          if (p.off) stem.push([at - 1, p.elbow, hx + 1, p.elbow + 2])
          return [{ at, head: [hx - 8, foot, hx + 8, foot + 16] as Box, stem }]
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
})

describe('pins past three lanes', () => {
  it('share the last head as one "+N" pin, in a fixed order, with no head hidden under another', () => {
    // five pins 2 px apart: three lanes, then the fourth and fifth join the third head
    const pins = pinLayout([0.3, 0.31, 0.32, 0.33, 0.34], 200)
    expect(pins.map((p) => p.into)).toEqual([-1, -1, -1, 2, 2])
    expect(pins.map((p) => p.lane)).toEqual([0, 1, 2, 2, 2])
    // a held pin sits where its head is
    expect(pins[3]!.off).toBe(pins[2]!.off)
    // with two lanes the third joins the second
    expect(pinLayout([0.3, 0.31, 0.32], 200, 2).map((p) => p.into)).toEqual([-1, -1, 1])
    // a pin far enough on starts a lane again
    expect(pinLayout([0.3, 0.31, 0.32, 0.33, 0.6], 200).map((p) => [p.lane, p.into])).toEqual([[0, -1], [1, -1], [2, -1], [2, 2], [0, -1]])
  })
  it('lays out the same whatever order the marks come in, and a pin added further on moves none before it', () => {
    const shares = [0.3, 0.3, 0.31, 0.5, 0.5]
    const keys = ['a', 'b', 'c', 'd', 'e']
    const base = pinLayout(shares, 300, 3, keys)
    const named = (ps: ReturnType<typeof pinLayout>, ks: string[]) => Object.fromEntries(ps.map((p, k) => [ks[k], { ...p, into: p.into < 0 ? '' : ks[p.into] }]))
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 0, 3, 2, 4]]) {
      const ks = order.map((i) => keys[i]!)
      expect(named(pinLayout(order.map((i) => shares[i]!), 300, 3, ks), ks)).toEqual(named(base, keys))
    }
    expect(pinLayout([...shares, 0.9], 300, 3, [...keys, 'f']).slice(0, 5)).toEqual(base)
  })
})

describe('which pin a pointer picks', () => {
  // two heads in different lanes 17 px apart and 18 px up, a third in the first lane 17 px clear of the second, as pinLayout places them
  const heads: PinHead[] = [
    { x: 100, y: 50, layer: 20, z: 3.75, ids: ['a'] },
    { x: 117, y: 32, layer: 20, z: 3.7, ids: ['b'] },
    { x: 134, y: 50, layer: 21, z: 3.95, ids: ['c'] },
  ]
  it('a mouse gets the nearest head, so where two hit areas meet only one pin answers', () => {
    expect(pinsAt(100, 50, heads, false).map((h) => h.ids[0])).toEqual(['a'])
    expect(pinsAt(110, 40, heads, false).map((h) => h.ids[0])).toEqual(['b'])
    // exactly halfway between two heads: the lower layer, then the lower height
    expect(pinsAt(117, 50, heads, false).map((h) => h.ids[0])).toEqual(['a'])
    expect(pinsAt(108.5, 41, heads, false).map((h) => h.ids[0])).toEqual(['b'])
  })
  it('a finger on a head gets that pin; between close heads it gets all of them, nearest first, for a list', () => {
    for (const h of heads) expect(pinsAt(h.x, h.y, heads, true).map((p) => p.ids[0])).toEqual(h.ids)
    expect(pinsAt(112, 44, heads, true).map((h) => h.ids[0])).toEqual(['b', 'a'])
    expect(pinsAt(100, 50 + TOUCH_R + 1, heads, true)).toEqual([])
  })
  it('every head pinLayout places is further than a finger from every other, so a tap on one picks only it', () => {
    for (const px of [120, 200, 340, 700])
      for (const layers of [[19, 20, 20, 21, 149], [4, 19, 20, 21, 22, 23, 119], [10, 11, 12, 13, 14, 15, 16], [0, 3, 30, 31, 33, 300]]) {
        const shares = layers.map((l) => l / 303)
        const heads = pinLayout(shares, px).flatMap((p, i) => (p.into >= 0 ? [] : [{ x: shares[i]! * px + p.off, y: -(19 + p.lane * 18) }]))
        for (const [i, a] of heads.entries()) for (const b of heads.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y), `${layers} at ${px}`).toBeGreaterThan(TOUCH_R)
      }
  })
  it('names a mark by its kind, layer and height', () => {
    expect(markName({ kind: 'color_change' }, 20, Array.from({ length: 30 }, (_, i) => 0.2 + i * 0.1875))).toBe('Color change at layer 20, 3.76 mm')
  })
})

describe('a slot on a color change is a note', () => {
  beforeEach(() => set({ layerMarks: {}, activePlate: 'plate-1' }))

  it('leaves the slice current, while adding or removing a mark makes it stale', () => {
    const result = { id: 'r', layerZ: new Float32Array([0.2]) } as never
    const before = get()
    const a = addMark(2, 'color_change', undefined, undefined, 2)!
    const withMark = get()
    expect(inputsChanged(before, withMark)).toBe(true)
    setMarkSlot(a.id, 3)
    expect(inputsChanged(withMark, get())).toBe(false)
    // with Auto slice on, the slot edit leaves a finished slice as it is; a removed mark stales it
    set({ autoSlice: true, slice: { status: 'done', result, stale: false } })
    const stop = startAutoSlice({} as never, 60_000)
    try {
      setMarkSlot(a.id, 1)
      expect(get().slice).toMatchObject({ stale: false })
      removeMark(a.id)
      expect(get().slice).toMatchObject({ stale: true })
    } finally {
      stop()
      set({ autoSlice: false, slice: { status: 'idle' } })
    }
  })
})

describe('a right-click on layers of different heights', () => {
  // a 0.3 mm first layer, then 0.12, then a run of 0.08 (variable layer height)
  const layerZ = [0.3, 0.42, 0.54, 0.62, 0.7, 0.78, 0.86]
  const track = { left: 0, width: 13 + 60 }
  it('lands on a sliced layer and takes its height from the layer list, not a nominal step', () => {
    const at = (x: number) => layerAtPoint(x, track, layerZ.length)
    // 10 px per layer slot whatever the height: slots, not millimeters
    expect([0, 6.5, 16.5, 26.5, 36.5, 66.5, 73].map(at)).toEqual([1, 1, 2, 3, 4, 7, 7])
    expect(layerZ[at(36.5) - 1]).toBe(0.62)
    // the first and last layers at the ends, and halfway between two slots goes up
    expect(at(-20)).toBe(1)
    expect(at(500)).toBe(layerZ.length)
    expect(at(6.5 + 15)).toBe(3)
    expect(at(6.5 + 14.9)).toBe(2)
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

describe('a mark at a layer top round trip', () => {
  beforeEach(() => set({ layerMarks: {}, activePlate: 'plate-1' }))

  /** The engine's rule for a mark by height: the first f32 layer top at or above its height less the tolerance. */
  const engineLayer = (z: number, tops: ArrayLike<number>): number => {
    for (let i = 0; i < tops.length; i++) if (Math.fround(tops[i]!) >= Math.fround(z - 1e-4)) return i
    return tops.length - 1
  }
  /** Layer tops as the preview holds them (f32), from a first layer and then `next(i)` per layer. */
  const stack = (first: number, count: number, next: (i: number) => number): Float32Array => {
    const tops = new Float32Array(count)
    let z = first
    for (let i = 0; i < count; i++) {
      tops[i] = z
      z += next(i)
    }
    return tops
  }
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const stacks: [string, Float32Array][] = [
    ...[0.08, 0.1, 0.12, 0.15, 0.16, 0.2, 0.24, 0.28, 0.3, 0.32].map((h): [string, Float32Array] => [`${h} mm`, stack(0.2, Math.min(1200, Math.floor(300 / h)), () => h)]),
    ['variable 0.08 to 0.32 mm', stack(0.2, 1200, () => 0.08 + Math.round(rand() * 24) / 100)],
    ['variable, smooth', stack(0.24, 1200, (i) => 0.2 + 0.12 * Math.sin(i / 9))],
  ]

  it.each(stacks)('every layer of %s reads back as itself and goes in that layer of the G-code', (_name, tops) => {
    for (let i = 0; i < tops.length; i++) {
      const mark = addMark(tops[i]!, 'pause')!
      expect(layerOf(mark, tops), `layer ${i + 1} at ${tops[i]} kept as ${mark.z}`).toBe(i + 1)
      expect(engineLayer(layerGcodeByHeight([mark])[0]!.zMm, tops)).toBe(i)
      removeMark(mark.id)
      // between two tops: the layer above, in the slider and in the G-code alike
      if (i > 0) {
        const mid = addMark((tops[i - 1]! + tops[i]!) / 2, 'pause')!
        expect(layerOf(mid, tops)).toBe(i + 1)
        expect(engineLayer(mid.z, tops)).toBe(i)
        removeMark(mid.id)
      }
    }
  })
})

describe('pin lanes before the track is measured', () => {
  it('keeps every pin in the first lane', () => {
    expect(pinLanes([0.1, 0.5, 0.55], 0)).toEqual([0, 0, 0])
  })
})
