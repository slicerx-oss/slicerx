// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus, platform } from 'node:os'
import { expect, it } from 'vitest'
import { clearReplayCache, IDENTITY, replayHistory, type History, type HistoryMesh } from '@slicerx/cad-history'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { scanStl } from '../src/export/stl-scan'

const meshPath = process.env['SX_GEOM_WASM'] ?? new URL('../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url)
const available = existsSync(meshPath)
if (process.env['SX_BREP_REQUIRE_MIXED'] === '1' && !available) throw new Error('mixed replay requires the real geometry WASM')

function importedCube(): HistoryMesh {
  const corners = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
  const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const bytes = new Uint8Array(84 + triangles.length * 50)
  const view = new DataView(bytes.buffer)
  view.setUint32(80, triangles.length, true)
  triangles.forEach((t, i) => t.forEach((c, k) => corners[c]!.forEach((v, axis) => view.setFloat32(96 + i * 50 + k * 12 + axis * 4, v, true))))
  const mesh = scanStl(bytes)!
  expect(mesh).not.toBeNull()
  return { name: 'Imported STL', slot: 1, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) }
}

function history(base: HistoryMesh, diameter: number): History {
  return { version: 1, base: [base], steps: [
    { id: 'native', part: 1, transform: [...IDENTITY], params: { op: 'shape.extrude', name: 'Exact plate', frame: { origin: [30, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { operation: 'new', distanceMm: 5 } } },
    { id: 'hole', part: 1, transform: [...IDENTITY], params: { op: 'subtract', label: 'Exact hole', solids: [{ type: 'cylinder', origin: [30, 0, 0], axis: [0, 0, 1], diameterMm: diameter, heightMm: 5 }] } },
    { id: 'import-cut', part: 0, transform: [...IDENTITY], params: { op: 'plane.cut', plane: { point: [0, 0, 5], normal: [0, 0, 1] }, keep: 'below' } },
  ] }
}

function checkMesh(mesh: HistoryMesh, volume: number, bounds: number[], tolerance = volume * 0.001) {
  const p = mesh.positions, ix = mesh.indices
  let actual = 0
  const edges = new Map<string, number>()
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3, b = ix[i + 1]! * 3, c = ix[i + 2]! * 3
    actual += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
    for (let j = 0; j < 3; j++) {
      const x = ix[i + j]!, y = ix[i + (j + 1) % 3]!
      const key = `${Math.min(x, y)},${Math.max(x, y)}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  expect([...edges.values()].every(n => n === 2)).toBe(true)
  expect(Math.abs(actual - volume)).toBeLessThan(tolerance)
  for (let axis = 0; axis < 3; axis++) {
    const values = Array.from(p).filter((_, i) => i % 3 === axis)
    expect(Math.min(...values)).toBeCloseTo(bounds[axis * 2]!, 5)
    expect(Math.max(...values)).toBeCloseTo(bounds[axis * 2 + 1]!, 5)
  }
  return actual
}

it.skipIf(!available)('replays imported STL and exact parts independently with measured warm recovery', async () => {
  const loading = performance.now()
  const exactBytes = readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url))
  const kernel = brepModule(await init({ wasmBinary: exactBytes }))
  const exactLoadMs = performance.now() - loading
  const meshLoading = performance.now()
  const meshBytes = readFileSync(meshPath)
  const { instance } = await WebAssembly.instantiate(meshBytes, {})
  const mesh = instance.exports as unknown as GeomExports
  const meshLoadMs = performance.now() - meshLoading
  const base = importedCube(), original = JSON.stringify(base)
  const samples: object[] = []
  let operations: { op: string; ms: number }[] = []
  let peakWasmBytes = kernel.memoryBytes() + mesh.memory.buffer.byteLength
  const call = async (op: string, request: unknown) => {
    const start = performance.now()
    try { return op.startsWith('brep.') ? kernel.call(op.slice(5), request) : callEngine(mesh, op, request) }
    finally {
      operations.push({ op, ms: performance.now() - start })
      peakWasmBytes = Math.max(peakWasmBytes, kernel.memoryBytes() + mesh.memory.buffer.byteLength)
    }
  }
  clearReplayCache()
  try {
    // cold replay, edits, unchanged cache hits, and saved history reopened after cache eviction
    const cases = [4, 6, 6, 4, 4, 6].map((diameter, i) => ({ diameter, exact: true, mode: ['cold', 'edit', 'cache-hit', 'undo-cache-hit', 'reopen', 'edit'][i]! }))
    for (const exact of [true, false]) for (let i = 0; i < 5; i++) cases.push({ diameter: 6, exact, mode: 'warm-rebuild' })
    for (const [i, { diameter, exact, mode }] of cases.entries()) {
      if (i === 4 || i >= 6) clearReplayCache()
      const source = history(base, diameter)
      const saved = JSON.stringify(source)
      operations = []
      const start = performance.now()
      const result = await replayHistory(call, { history: JSON.parse(saved) as History, exact }, { keepsBodies: true })
      const replayMs = performance.now() - start
      expect(result.status.map(s => s.state)).toEqual(['done', 'done', 'done'])
      expect(result.exactFellBack ?? []).toEqual([])
      expect(result.parts).toHaveLength(2)
      checkMesh(result.parts[0]!, 500, [0, 10, 0, 10, 0, 5])
      const radius = diameter / 2, expectedVolume = 1000 - Math.PI * radius ** 2 * 5
      // solids.rs uses a 0.02 mm chord tolerance; the surrounding annulus bounds its missing hole volume
      const meshTolerance = Math.PI * (radius ** 2 - (radius - 0.02) ** 2) * 5 + 1e-4
      const actualVolume = checkMesh(result.parts[1]!, expectedVolume, [20, 40, -5, 5, 0, 5], exact ? expectedVolume * 0.001 : meshTolerance)
      expect(JSON.stringify(source)).toBe(saved)
      expect(JSON.stringify(base)).toBe(original)
      if (i === 0 || i === 4 || i >= 6) {
        expect(operations.map(o => o.op)).toContain(exact ? 'brep.extrude' : 'shape.extrude')
        expect(operations.map(o => o.op)).toContain(exact ? 'brep.subtract' : 'subtract')
        expect(operations.map(o => o.op)).toContain('cut')
      }
      const sum = (predicate: (op: string) => boolean) => operations.filter(o => predicate(o.op)).reduce((n, o) => n + o.ms, 0)
      samples.push({ iteration: i, mode, exact, diameterMm: diameter, volumeErrorMm3: actualVolume - expectedVolume, replayMs, engineCalls: operations, tessellateMs: sum(op => op === 'brep.tessellate'), kernelOperationMs: sum(op => op.startsWith('brep.') && !['brep.tessellate', 'brep.free'].includes(op)), meshOperationMs: sum(op => !op.startsWith('brep.')), replayOverheadMs: replayMs - sum(() => true), liveBodies: (kernel.call('count', {}) as { bodies: number }).bodies })
    }
  } finally {
    clearReplayCache()
    await replayHistory(call, { history: { version: 1, base: [], steps: [] }, exact: true }, { keepsBodies: true })
    expect(kernel.call('count', {})).toEqual({ bodies: 0 })
  }
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const profile = { platform: platform(), cpu: cpus()[0]?.model, node: process.version, exactSha256: digest(exactBytes), meshSha256: digest(meshBytes), exactLoadMs, meshLoadMs, peakWasmBytes, processPeakRssBytes: process.resourceUsage().maxRSS * 1024, samples }
  const output = process.env['SX_BREP_PROFILE_PATH']
  if (output) writeFileSync(output, JSON.stringify(profile, null, 2) + '\n')
}, 60_000)
