// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand built in three tagged extrudes on a host with no engine (a block, a stand on it, a top on the stand), and
// its display plan with the top planned on the block: its check fails on what the top stands on.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PartPlan } from '../src/design-check'

export type Tri = [number[], number[], number[]]
export function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}
export const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const frame = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
/** An extrude step tagged with its feature, rising `mm` from height `z`. */
const extrude = (id: string, feature: string, z: number, mm: number, w: number, h: number) => ({ id, part: 0, feature, transform: IDENTITY, params: { op: 'shape.extrude', frame: frame(z), shape: { type: 'rectangle', widthMm: w, heightMm: h }, placement: { center: [20, 10] }, spec: { distanceMm: mm, operation: 'new' } } })

/** A block 4 mm tall, a stand on it up to 10 mm, and a top on the stand up to 12 mm: one closed body, d1. */
export function standHost(): { host: DesignHost; design: HostDesign } {
  const design = {
    id: 'd1',
    name: 'Stand',
    history: { version: 1, base: [], steps: [extrude('s1', 'Block', 0, 4, 40, 20), extrude('s2', 'Stand', 4, 6, 10, 10), extrude('s3', 'Top', 10, 2, 20, 20)] },
    transform: IDENTITY,
    parts: [{ name: 'Stand', slot: 0, ...meshOf(boxTris([0, 0, 0], [40, 20, 12])) }],
    status: [],
    madeBy: {},
    redo: [],
  } as unknown as HostDesign
  const host = {
    get: (id: string) => {
      if (id !== design.id) throw new Error(`no design ${id}`)
      return design
    },
    list: () => [design],
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: async (op: string) => (op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))),
  } as unknown as DesignHost
  return { host, design }
}

/** The stand's plan, its top planned on the block where it was built on the stand. */
export const STAND_PLAN: PartPlan = {
  planId: 'plan_1',
  part: 'Stand',
  units: 'mm',
  detail: 'display',
  features: [
    { name: 'Block', kind: 'extrude', sizes: { length: 40, width: 20, height: 4 } },
    { name: 'Stand', kind: 'extrude', on: 'Block', sizes: { width: 10, height: 6 } },
    { name: 'Top', kind: 'extrude', on: 'Block', sizes: { width: 20, height: 2 } },
  ],
  assumptions: [],
  questions: [],
} as PartPlan
