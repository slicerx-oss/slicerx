// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights: the printer's limits, the curve, the tops a slice gets from it, and the profile made
// from sleipnir's plan that the editor starts from.
import { describe, expect, it } from 'vitest'
import { cleanProfile, flatProfile, heightAt, layerLimits, plateProfileFromFile, profileFromTops, profileTops, type ProfilePoint } from '../src/plate/layer-profile'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

const LIMITS = { minMm: 0.08, maxMm: 0.28, firstMm: 0.2 }
const thick = (tops: number[]) => tops.map((t, i) => Number((t - (i ? tops[i - 1]! : 0)).toFixed(4)))

describe("the printer's limits", () => {
  it('reads min and max layer height and the first layer from the resolved config', () => {
    expect(layerLimits({ nozzle_diameter: [0.4], min_layer_height: [0.08], max_layer_height: [0.28], initial_layer_print_height: 0.2 })).toEqual(LIMITS)
  })

  it('falls back to 0.07 mm and three quarters of the nozzle when the printer leaves them at 0', () => {
    expect(layerLimits({ nozzle_diameter: [0.6], min_layer_height: [0], max_layer_height: [0], initial_layer_print_height: 0.3 })).toEqual({ minMm: 0.07, maxMm: 0.45, firstMm: 0.3 })
  })

  it('keeps them inside what the engine takes, and starts over a raft at the layer height', () => {
    expect(layerLimits({ nozzle_diameter: [1.8], min_layer_height: [0.01], max_layer_height: [2], layer_height: 0.3, raft_layers: 2, initial_layer_print_height: 0.5 })).toEqual({ minMm: 0.04, maxMm: 0.8, firstMm: 0.3 })
  })
})

describe('the curve', () => {
  const pts: ProfilePoint[] = [[2, 0.1], [6, 0.3]]
  it('is straight between points and flat past the ends', () => {
    expect(heightAt(pts, 0)).toBe(0.1)
    expect(heightAt(pts, 4)).toBeCloseTo(0.2, 9)
    expect(heightAt(pts, 9)).toBe(0.3)
  })

  it('is cleaned: sorted, finite, one point per height, heights inside the limits', () => {
    const got = cleanProfile([[5, 0.5], [1, 0.12], [1, 0.16], [Number.NaN, 0.1], [-1, 0.1], [3, 0.01]], LIMITS)
    expect(got).toEqual({ points: [[1, 0.16], [3, 0.08], [5, 0.28]], clamped: true, dropped: true })
    expect(cleanProfile([[1, 0.12]], LIMITS)).toEqual({ points: [[1, 0.12]], clamped: false, dropped: false })
    expect(cleanProfile([], LIMITS)).toBeNull()
  })
})

describe('the tops a profile slices at', () => {
  it('start at the first layer height, follow the curve, and reach the top of the plate', () => {
    const tops = profileTops([[0, 0.1], [10, 0.1]], 1, LIMITS)
    expect(tops[0]).toBe(0.2)
    expect(thick(tops).slice(1).every((t) => Math.abs(t - 0.1) < 1e-9)).toBe(true)
    expect(tops[tops.length - 1]).toBe(1)
    expect(tops[tops.length - 2]).toBeLessThan(1)
  })

  it('end on the top of the plate, a last sliver joining the layer below or sharing its height', () => {
    // 0.25 mm left over a 0.2 mm curve: the last layer is 0.05, under the minimum, and joins the one below.
    const joined = profileTops([[0, 0.2]], 1.05, LIMITS)
    expect(joined[joined.length - 1]).toBe(1.05)
    expect(thick(joined).slice(-2)).toEqual([0.2, 0.25])
    // At 0.26 mm layers a 0.05 sliver would make one layer of 0.31, past the maximum, so the two share it.
    const shared = profileTops([[0, 0.26]], 1.03, LIMITS)
    expect(shared[shared.length - 1]).toBe(1.03)
    expect(thick(shared).slice(-2)).toEqual([0.155, 0.155])
    // A last layer at or over the minimum stays as it is.
    expect(thick(profileTops([[0, 0.2]], 1.1, LIMITS)).slice(-1)).toEqual([0.1])
  })

  it('thicken where the curve rises, and every layer stays inside the limits', () => {
    const tops = profileTops([[1, 0.08], [5, 0.28]], 6, LIMITS)
    const t = thick(tops).slice(1)
    for (const h of t) {
      expect(h).toBeGreaterThanOrEqual(0.08 - 1e-9)
      expect(h).toBeLessThanOrEqual(0.28 + 1e-9)
    }
    expect(t[0]).toBe(0.08)
    expect(Math.max(...t)).toBe(0.28)
    // The last two may share what is left under the top; below them the layers only thicken.
    for (let i = 1; i < t.length - 2; i++) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]! - 1e-9)
  })

  it('clamp a curve outside the limits instead of passing it on', () => {
    const t = thick(profileTops([[0, 0.01], [10, 2]], 10, LIMITS)).slice(1)
    expect(Math.min(...t)).toBe(0.08)
    expect(Math.max(...t)).toBe(0.28)
  })

  it('are a flat curve when the profile is flat', () => {
    expect(profileTops(flatProfile(0.2, 2, LIMITS), 2, LIMITS)).toEqual([0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2])
  })
})

describe('a profile from a plan', () => {
  it('keeps the bends and drops the points on a straight run, with the first layer left out', () => {
    const tops = [0.2]
    for (let i = 0; i < 20; i++) tops.push(Number((tops[i]! + 0.1).toFixed(4)))
    for (let i = 0; i < 20; i++) tops.push(Number((tops[tops.length - 1]! + 0.2).toFixed(4)))
    const pts = profileFromTops(tops)
    expect(pts[0]).toEqual([0.2, 0.1])
    expect(pts[pts.length - 1]![1]).toBe(0.2)
    expect(pts.length).toBeLessThanOrEqual(5)
    // The tops it gives back are the plan's own.
    expect(profileTops(pts, tops[tops.length - 1]!, LIMITS)).toEqual(tops)
  })

  it('holds at most the points asked for', () => {
    const tops = [0.2]
    for (let i = 0; i < 300; i++) tops.push(Number((tops[i]! + (i % 2 ? 0.1 : 0.25)).toFixed(4)))
    expect(profileFromTops(tops, 24).length).toBeLessThanOrEqual(24)
  })
})

describe("a plate's profile from a project file's objects", () => {
  const box = (z: number, h: number) => ({ parts: [{ ...boxMesh(10, 10, h), name: 'Body', slot: 1 }], transform: compose({ position: [50, 50, z], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

  it('moves each object profile up by where its bottom sits', () => {
    const got = plateProfileFromFile([{ name: 'a', points: [[0, 0.12], [4, 0.2]], entry: box(1, 4) }], LIMITS)
    expect(got).toEqual({ points: [[1, 0.12], [5, 0.2]], clamped: false })
  })

  it("uses the tallest object's when the objects' profiles differ, and names it", () => {
    const got = plateProfileFromFile([{ name: 'short', points: [[0, 0.12], [4, 0.12]], entry: box(0, 4) }, { name: 'tall', points: [[0, 0.2], [9, 0.2]], entry: box(0, 9) }, { name: 'none', entry: box(0, 2) }], LIMITS)
    expect(got).toEqual({ points: [[0, 0.2], [9, 0.2]], clamped: false, from: 'tall' })
  })

  it('keeps heights the printer does not print inside its limits and says so', () => {
    expect(plateProfileFromFile([{ name: 'a', points: [[0, 0.02], [4, 0.6]], entry: box(0, 4) }], LIMITS)).toEqual({ points: [[0, 0.08], [4, 0.28]], clamped: true })
    expect(plateProfileFromFile([{ name: 'a', entry: box(0, 4) }], LIMITS)).toBeNull()
  })
})
