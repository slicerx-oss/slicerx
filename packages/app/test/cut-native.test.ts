// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { cutObject } from '../src/plate/cut-object'
import { bake, boxMesh } from '../src/plate/mesh-ops'
import { bounds, compose, identity } from '../src/plate/transform'
import { get, set } from '../src/state/store'

const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
if (process.env['SLICERX_TEST_REQUIRE_SX'] === '1' && !existsSync(bin)) throw new Error('The real sx-geom binary is required for cut tests.')
const host = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n,p) => n + p.indices.length / 3, 0), bboxMm: [60,40,30], openEdges: 0, parts: [] }) }

describe.skipIf(!existsSync(bin))('Prepare cuts through the real geometry engine', () => {
  beforeEach(async () => {
    const part = boxMesh(60,40,30)
    set({ plate: [{ id: 'body', name: 'Body', handle: await host.loadParts('Body', [part]), parts: [part], colors: ['#ffffff'], transform: identity(), printable: false }], plates: [], activePlate: 'plate', objectSettings: { body: { wall_loops: 4 } }, selection: 'body', selectedIds: ['body'], historyEdit: null, rollback: null })
    setGeomProvider({ call: async <T>(op: string, request: unknown): Promise<T> => JSON.parse(execFileSync(bin, [op], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })) as T })
  })
  afterEach(() => setGeomProvider(null))

  it.each(['pin', 'dowel', 'dovetail'] as const)('creates %s connectors with closed halves and actual placement reports', async (kind) => {
    const result = await cutObject(host, 'body', { axis: 'z', atMm: 15, keep: 'both', connector: { kind, diameterMm: 5, depthMm: 6, toleranceMm: 0.2 } })
    expect(result.changed).toBe(true)
    expect(result.ids.length).toBeGreaterThanOrEqual(2)
    expect(result.reports[0]!.report.connectors.length).toBeGreaterThan(0)
    expect(result.reports[0]!.report.belowEdges).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 })
    expect(result.reports[0]!.report.aboveEdges).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 })
    for (const entry of get().plate) {
      expect(entry.printable).toBe(false)
      expect(get().objectSettings[entry.id]).toEqual({ wall_loops: 4 })
    }
  })

  it('reports explicit dowels and their separate printable meshes', async () => {
    const positions: [number,number,number][] = [[-10,0,15],[10,0,15]]
    const result = await cutObject(host, 'body', { axis: 'z', atMm: 15, keep: 'both', connector: { kind: 'dowel', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, positions } })
    expect(result.reports[0]!.report.connectors).toEqual(positions)
    expect(result.ids).toHaveLength(4)
    expect(get().plate.filter((entry) => entry.name.includes('connector'))).toHaveLength(2)
  })

  it.each(['above', 'below'] as const)('keeps only the %s half of an oblique cut', async (keep) => {
    const result = await cutObject(host, 'body', { axis: 'z', atMm: 0, plane: { point: [0,0,15], normal: [0.2,0,1] }, keep })
    expect(result.ids).toHaveLength(1)
    expect(result.reports[0]!.report.belowVolumeMm3).toBeGreaterThan(0)
    expect(result.reports[0]!.report.aboveVolumeMm3).toBeGreaterThan(0)
    expect(get().plate[0]!.name).toContain(keep === 'above' ? 'upper' : 'lower')
  })

  it('reports skipped connectors and leaves an outside cut unchanged', async () => {
    const skipped = await cutObject(host, 'body', { axis: 'z', atMm: 15, keep: 'both', connector: { kind: 'pin', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, positions: [[100,100,15]] } })
    expect(skipped.reports[0]!.report.connectors).toEqual([])
    expect(skipped.warnings.length).toBeGreaterThan(0)
    const before = get().plate
    const result = await cutObject(host, before[0]!.id, { axis: 'z', atMm: 1000, keep: 'both' })
    expect(result.changed).toBe(false)
    expect(get().plate).toBe(before)
  })

  it('cuts translated, rotated and scaled geometry in bed coordinates', async () => {
    const entry = get().plate[0]!
    set({ plate: [{ ...entry, transform: compose({ position: [70,40,12], rotation: [0,0,30], scale: [1.5,0.75,2] }) }] })
    const result = await cutObject(host, 'body', { axis: 'z', atMm: 42, keep: 'both' })
    expect(result.ids).toHaveLength(2)
    const report = result.reports[0]!.report
    expect(report.belowVolumeMm3).toBeCloseTo(81_000, 0)
    expect(report.aboveVolumeMm3).toBeCloseTo(81_000, 0)
    for (const piece of get().plate) {
      const box = bounds(piece.parts, piece.transform)!
      expect(box.min[2]).toBeCloseTo(0, 5)
      expect(box.max[2]).toBeCloseTo(30, 5)
    }
  })

  it('keeps multipart material and settings when only one part crosses the plane', async () => {
    const entry = get().plate[0]!
    const body = { ...entry.parts[0]!, name: 'body', slot: 1 }
    const cap = { ...bake(boxMesh(10,10,10), compose({ position: [55,0,25], rotation: [0,0,0], scale: [1,1,1] })), name: 'cap', slot: 2 }
    set({ plate: [{ ...entry, parts: [body,cap], colors: ['#ff0000','#0000ff'], slotOverrides: { cap: 3 }, partSettings: { cap: { wall_loops: 7 } } }] })
    const result = await cutObject(host, 'body', { axis: 'z', atMm: 15, keep: 'both' })
    expect(result.ids).toHaveLength(2)
    expect(result.reports).toHaveLength(2)
    const below = get().plate.find((piece) => piece.name.endsWith('lower'))!
    const above = get().plate.find((piece) => piece.name.endsWith('upper'))!
    expect(below.parts.map((part) => part.name)).toEqual(['body'])
    expect(above.parts.map((part) => part.name)).toEqual(['body','cap'])
    expect(above.parts.map((part) => part.slot)).toEqual([1,3])
    expect(above.colors).toEqual(['#ff0000','#0000ff'])
    expect(above.partSettings).toEqual({ cap: { wall_loops: 7 } })
    expect(Math.abs(result.reports[1]!.report.belowVolumeMm3)).toBe(0)
    expect(result.reports[1]!.report.aboveVolumeMm3).toBeCloseTo(1000, 4)
  })

})
