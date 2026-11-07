// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights in a project file: written as each object's layer_height_profile, from its bottom to its
// top, the form other slicers' project files use, and read back onto the plate.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { readLayerHeights } from '@slicerx/threemf/layer-heights'
import { readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { cleanProfile, heightAt, plateProfileFromFile, profileTops } from '../src/plate/layer-profile'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const LIMITS = { minMm: 0.08, maxMm: 0.28 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const box = (id: string, x: number, h: number): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(10, 10, h), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const PROFILE: [number, number][] = [[0.2, 0.12], [4, 0.12], [8, 0.24]]
/** Two objects' lines in the form other slicers save: six decimals, semicolons, a pair for each layer. */
const FIXTURE = 'object_id=1|0.000000;0.200000;0.200000;0.200000;0.360000;0.160000;0.480000;0.120000;0.600000;0.120000;10.000000;0.120000\nobject_id=2|0.000000;0.200000;6.000000;0.280000\n'
const input = (profile?: [number, number][]) => ({ plates: [{ id: 'p1', name: 'Plate 1', objects: [box('tall', 50, 10), box('short', 100, 6)], settings: profile ? { layerProfile: profile } : {} }], bed, settings: {} })

describe('a plate profile in a project file', () => {
  it('is written per object, from 0 to each object height, ending on its top', () => {
    const part = projectFiles(input(PROFILE)).find((f) => f.name === 'Metadata/layer_heights_profile.txt')
    expect(String(part!.data).split('\n')).toEqual([
      'object_id=1|0;0.12;0.2;0.12;4;0.12;8;0.24;10;0.24',
      'object_id=2|0;0.12;0.2;0.12;4;0.12;6;0.18',
      '',
    ])
  })

  it('is not written for a plate without one', () => {
    expect(projectFiles(input()).some((f) => f.name.includes('layer_heights_profile'))).toBe(false)
  })

  it('reads back onto the plate: the tallest object keeps the whole curve', async () => {
    const p = await readProject(writeProject(input(PROFILE)), bed)
    const objs = p.plates[0]!.objects
    expect(objs.map((o) => o.layerProfile?.length)).toEqual([5, 4])
    const got = plateProfileFromFile(objs.map((o) => ({ name: o.name, ...(o.layerProfile ? { points: o.layerProfile } : {}), entry: { parts: o.parts, transform: o.transform } })), LIMITS)
    expect(got!.points).toEqual([[0, 0.12], [0.2, 0.12], [4, 0.12], [8, 0.24], [10, 0.24]])
    expect(got!.clamped).toBe(false)
  })

  it("reads another slicer's file under the older part name, numbering objects from 1", async () => {
    const files = projectFiles(input()).concat([{ name: 'Metadata/Slic3r_PE_layer_heights_profile.txt', data: 'object_id=2|0;0.1;3;0.3;6;0.3\n' }])
    const objs = (await readProject(zip(files), bed)).plates[0]!.objects
    expect(objs[0]!.layerProfile).toBeUndefined()
    expect(objs[1]!.layerProfile).toEqual([[0, 0.1], [3, 0.3], [6, 0.3]])
  })

  it("reads lines in other slicers' form: semicolons, six decimals, one pair per layer", async () => {
    // Made by hand in the form of their saved projects; the next test reads one from a real project.
    const files = projectFiles(input()).concat([{ name: 'Metadata/layer_heights_profile.txt', data: FIXTURE }])
    const objs = (await readProject(zip(files), bed)).plates[0]!.objects
    expect(objs[0]!.layerProfile).toEqual([[0, 0.2], [0.2, 0.2], [0.36, 0.16], [0.48, 0.12], [0.6, 0.12], [10, 0.12]])
    expect(objs[1]!.layerProfile).toEqual([[0, 0.2], [6, 0.28]])
  })

  it('reads the profile part of a project from another slicer', () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'layer-heights-profile-another-slicer.txt'), 'utf8')
    const got = readLayerHeights(text)
    expect([...got.keys()]).toEqual([3, 4, 5])
    const three = got.get(3)!
    expect(three).toHaveLength(37)
    expect(three[0]).toEqual([0, 0.2])
    expect(three[three.length - 1]![0]).toBe(3.483481)
    expect(Math.min(...three.map((p) => p[1]))).toBe(0.08)
    expect(Math.max(...three.map((p) => p[1]))).toBe(0.2)
    // rising heights, as the curve needs
    expect(three.every((p, i) => i === 0 || p[0] >= three[i - 1]![0])).toBe(true)
    expect([got.get(4)!.length, got.get(5)!.length]).toEqual([67, 71])
    // Pairs from the middle, as the file gives them.
    expect(three[5]).toEqual([0.584689, 0.104689])
    expect(three[20]).toEqual([2.153869, 0.116496])
    expect(got.get(4)![20]).toEqual([2.363957, 0.083974])
    expect(got.get(4)![40]).toEqual([4.146684, 0.097216])
    expect(got.get(5)![5]).toEqual([1, 0.28])
    expect(got.get(5)![40]).toEqual([6.834527, 0.125958])
  })

  it("slices a curve from another slicer's project at layers the printer prints", () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'layer-heights-profile-another-slicer.txt'), 'utf8')
    const limits = { minMm: 0.08, maxMm: 0.28, firstMm: 0.2 }
    for (const [, pairs] of readLayerHeights(text)) {
      const clean = cleanProfile(pairs, limits)!
      const top = pairs[pairs.length - 1]![0]
      const tops = profileTops(clean.points, top, limits)
      expect(tops[0]).toBe(0.2)
      expect(tops[tops.length - 1]).toBeGreaterThanOrEqual(top - 1e-3)
      tops.slice(1).forEach((t, i) => {
        const h = Number((t - tops[i]!).toFixed(4))
        expect(h).toBeGreaterThanOrEqual(limits.minMm)
        expect(h).toBeLessThanOrEqual(limits.maxMm)
      })
      // Each layer follows the file's curve where it starts, inside the limits.
      tops.slice(1, -2).forEach((t, i) => {
        const want = Math.min(limits.maxMm, Math.max(limits.minMm, heightAt(clean.points, tops[i]!)))
        expect(Math.abs(t - tops[i]! - want)).toBeLessThan(2e-4)
      })
    }
  })

  it('still reads the comma form, and a mix of separators', () => {
    expect([...readLayerHeights('object_id=1|0,0.2,4,0.1\nobject_id=2|0;0.2, 4 ;0.1\n')]).toEqual([[1, [[0, 0.2], [4, 0.1]]], [2, [[0, 0.2], [4, 0.1]]]])
  })

  it('round-trips a lifted object, from its own bottom', async () => {
    const lifted = box('lifted', 50, 4)
    lifted.transform = compose({ position: [50, 60, 3], rotation: [0, 0, 0], scale: [1, 1, 1] })
    const curve: [number, number][] = [[0.2, 0.2], [5, 0.1]]
    const part = projectFiles({ plates: [{ id: 'p1', name: 'Plate 1', objects: [lifted], settings: { layerProfile: curve } }], bed, settings: {} }).find((f) => f.name === 'Metadata/layer_heights_profile.txt')
    // From 3 mm (its bottom) to 7 mm (its top) above the bed, written from 0 to 4.
    expect(String(part!.data)).toBe('object_id=1|0;0.1417;2;0.1;4;0.1\n')
    const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [lifted], settings: { layerProfile: curve } }], bed, settings: {} }), bed)
    const o = p.plates[0]!.objects[0]!
    const got = plateProfileFromFile([{ name: o.name, points: o.layerProfile!, entry: { parts: o.parts, transform: o.transform } }], LIMITS)
    expect(got!.points).toEqual([[3, 0.1417], [5, 0.1], [7, 0.1]])
  })

  it('keeps a profile outside the printer limits inside them', () => {
    const got = plateProfileFromFile([{ name: 'a', points: [[0, 0.02], [3, 0.5]] }], LIMITS)
    expect(got).toEqual({ points: [[0, 0.08], [3, 0.28]], clamped: true })
  })

  it('reads untrusted lines safely: bad numbers, an odd count and junk lines are left out', () => {
    expect([...readLayerHeights('object_id=1|0,0.2,x,0.3,1,0.1,7\nobject_id=x|0,1\njunk\nobject_id=3|\n')]).toEqual([[1, [[0, 0.2], [1, 0.1]]]])
  })
})
