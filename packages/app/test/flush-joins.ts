// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Joins made flush onto the flat top of an exact part, and a check that every host hands a mesh step its meshes in
// f32, for the hosts' tests (cad-exact-native.test.ts, native-provider.test.ts).
import type { EngineCall, History } from '@slicerx/cad-history'

const Z = (x: number, y: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
const up = (x: number, y: number, z: number) => ({ origin: [x, y, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })

/**
 * Two designs whose second step joins a mesh body flush onto the flat top of an exact one, placed on the plate as the
 * app placed them: a disc with a lofted post, and a cylinder with a revolved cone. The kernel's points on such a top
 * sit up to a few 1e-14 mm off its plane in f64, and a join onto them was refused as unsafe at mesh storage precision.
 */
export const FLUSH_JOINS: { name: string; history: History }[] = [
  {
    name: 'a disc with a lofted post joined on its top',
    history: { version: 1, base: [], steps: [
      { id: 'flush-disc-1', part: 0, transform: Z(0, 0), params: { op: 'shape.extrude', shape: { type: 'circle', diameterMm: 120 }, spec: { distanceMm: 12, extent: 'oneSide', operation: 'new' }, name: 'Base' } },
      { id: 'flush-disc-2', part: 0, transform: Z(128, 128), params: { op: 'sketch.loft', profiles: [{ loops: [{ type: 'circle', center: [0, 0], diameterMm: 40 }], frame: up(128, 128, 12) }, { loops: [{ type: 'circle', center: [0, 0], diameterMm: 28 }], frame: up(128, 128, 180) }], operation: 'join' } },
    ] } as History,
  },
  {
    name: 'a cylinder with a revolved cone joined on its top',
    history: { version: 1, base: [], steps: [
      { id: 'flush-cyl-1', part: 0, transform: Z(0, 0), params: { op: 'shape.extrude', shape: { type: 'circle', diameterMm: 50 }, spec: { distanceMm: 100, extent: 'oneSide', operation: 'new' }, name: 'Tube' } },
      { id: 'flush-cyl-2', part: 0, transform: Z(90, 90), params: { op: 'sketch.revolve', loops: [{ points: [[0, 100], [25, 100], [0, 150]] }], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 360, operation: 'join', frame: { origin: [90, 90, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] } } },
    ] } as History,
  },
]

/** Every mesh's positions in a request, wherever it sits (a target, a mesh, a list of them). */
function positionsIn(v: unknown, out: ArrayLike<number>[] = []): ArrayLike<number>[] {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return out
  if (Array.isArray(v)) {
    for (const e of v) if (e !== null && typeof e === 'object') positionsIn(e, out)
    return out
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === 'positions' && (Array.isArray(x) || ArrayBuffer.isView(x))) out.push(x as ArrayLike<number>)
    else positionsIn(x, out)
  }
  return out
}

/** `call`, refusing any mesh step whose meshes carry a coordinate an f32 cannot hold. */
export const f32Only = (call: EngineCall, host: string): EngineCall => async (op, request) => {
  if (!op.startsWith('brep.') && op !== 'exact.ops') {
    for (const p of positionsIn(request)) {
      for (let i = 0; i < p.length; i++) {
        const x = p[i]!
        if (Math.fround(x) !== x) throw new Error(`${host}: ${op} was handed ${x} at ${i}, which an f32 cannot hold`)
      }
    }
  }
  return await call(op, request)
}
