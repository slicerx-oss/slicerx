// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { applyMat, arraySpec, BED_FRAME, describeFeature, featurePoints, frameToBed, loopsOf, MAX_COPIES, readout, wholeMesh, type ArrayFields } from '../src/cad/cad-ops'

const fields = (over: Partial<ArrayFields>): ArrayFields => ({ kind: 'linear', count: 3, rows: 2, step: [30, 0, 0], center: [128, 128], angleDeg: 360, rotateCopies: true, ...over })

describe('array fields', () => {
  it('builds a line, a grid and a circle for the engine', () => {
    expect(arraySpec(fields({}))).toEqual({ kind: 'linear', count: 3, step: [30, 0, 0] })
    expect(arraySpec(fields({ kind: 'grid', count: 4, rows: 3, step: [30, 25, 0] }))).toEqual({ kind: 'linear', count: 4, step: [30, 0, 0], count2: 3, step2: [0, 25, 0] })
    expect(arraySpec(fields({ kind: 'circular', count: 6, angleDeg: 180, rotateCopies: false }))).toEqual({ kind: 'circular', count: 6, center: [128, 128, 0], axis: [0, 0, 1], angleDeg: 180, rotateCopies: false })
  })

  it('says what is wrong instead of asking the engine', () => {
    expect(arraySpec(fields({ count: 1 }))).toMatch(/at least 2/)
    expect(arraySpec(fields({ count: 2.5 }))).toMatch(/whole numbers/)
    expect(arraySpec(fields({ step: [0, 0, 0] }))).toMatch(/more than 0 mm/)
    expect(arraySpec(fields({ step: [Number.NaN, 0, 0] }))).toMatch(/needs a number/)
    expect(arraySpec(fields({ kind: 'grid', count: 30, rows: 30 }))).toContain(String(MAX_COPIES))
    expect(arraySpec(fields({ kind: 'grid', step: [30, 0, 0] }))).toMatch(/Both spacings/)
    expect(arraySpec(fields({ kind: 'circular', angleDeg: 0 }))).toMatch(/angle/)
  })
})

describe('frames and meshes', () => {
  it('maps face coordinates to the bed', () => {
    expect(frameToBed(BED_FRAME, [12, 7])).toEqual([12, 7, 0])
    // A wall facing +X: u runs along Y, v points up.
    const wall = { origin: [50, 10, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], u: [0, 1, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] }
    expect(frameToBed(wall, [4, 9])).toEqual([50, 14, 9])
    expect(loopsOf(wall, [{ outer: [[0, 0], [1, 0], [1, 1]], holes: [[[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]] }])).toHaveLength(2)
  })

  it('applies a column-major transform and joins parts into one mesh', () => {
    const move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]
    expect(applyMat(move, [1, 2, 3])).toEqual([11, 22, 33])
    const tri = (z: number) => ({ name: 'p', slot: 1, positions: new Float32Array([0, 0, z, 1, 0, z, 0, 1, z]), indices: new Uint32Array([0, 1, 2]) })
    const m = wholeMesh({ parts: [tri(0), tri(5)] })
    expect(m.positions).toHaveLength(18)
    expect(m.indices).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('measure readout', () => {
  it('lists the distance first, with units, and skips what the engine left out', () => {
    const rows = readout({ distanceMm: 12.3456, deltaMm: [-12, 2.9, 0], angleDeg: 0, parallel: true })
    expect(rows.map((r) => r.label)).toEqual(['Distance', 'Along X', 'Along Y', 'Along Z', 'Angle'])
    expect(rows[0]).toEqual({ label: 'Distance', value: '12.35 mm', copy: '12.346' })
    expect(rows[1]?.value).toBe('12.00 mm')
    expect(rows[4]?.value).toContain('parallel')
    expect(readout({ radiusMm: 2.5, diameterMm: 5, areaMm2: 0 }).map((r) => r.value)).toEqual(['2.500 mm', '5.000 mm'])
  })

  it('names features with their own size and marks them in the view', () => {
    expect(describeFeature({ kind: 'edge', a: [0, 0, 0], b: [3, 4, 0] })).toBe('Edge, 5.000 mm')
    expect(describeFeature({ kind: 'circle', center: [0, 0, 0], axis: [0, 0, 1], radius: 4, sweepDeg: 360 })).toBe('Circle, diameter 8.000 mm')
    expect(describeFeature({ kind: 'plane', point: [1, 2, 0], normal: [0, 0, 1], areaMm2: 0 })).toBe('Bed')
    expect(featurePoints({ kind: 'edge', a: [0, 0, 0], b: [3, 4, 0] })).toHaveLength(2)
  })
})
