// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project object whose parts sit away from its origin is centered on it (import3mf.ts, centerObject), the offset going
// into its placement. The parts are shifted where they lie rather than copied, so a big project does not hold a second
// copy of every such mesh while it opens. A buffer two parts share is copied, so each keeps its own shift, and centering
// the same parts again (a project laid out again) moves nothing twice.
import { describe, expect, it } from 'vitest'
import type { MeshPart } from '@slicerx/contracts'
import { centerObject } from '../src/export/import3mf'

const ID = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const tri = (x: number, y: number): MeshPart => ({ name: 'p', slot: 1, positions: new Float32Array([x, y, 0, x + 10, y, 0, x, y + 20, 5]), indices: new Uint32Array([0, 1, 2]) })

describe('centering a placed object', () => {
  it('shifts its parts in place and moves the offset into the placement', () => {
    const part = tri(100, 50)
    const before = part.positions
    const parts = [part]
    const t = ID()
    expect(centerObject(parts, [], t, undefined, new Map())).toEqual([105, 60])
    expect(parts[0]!.positions).toBe(before)
    expect([...parts[0]!.positions]).toEqual([-5, -10, 0, 5, -10, 0, -5, 10, 5])
    expect(t.slice(12, 15)).toEqual([105, 60, 0])
  })

  it('copies a buffer another object also uses, so both get their own shift', () => {
    const shared = tri(100, 50)
    const uses = new Map([[shared.positions, 2]])
    const a = [shared]
    const b = [{ ...shared }, tri(200, 50)]
    centerObject(a, [], ID(), undefined, uses)
    centerObject(b, [], ID(), undefined, uses)
    expect(a[0]!.positions).not.toBe(shared.positions)
    expect([...shared.positions]).toEqual([100, 50, 0, 110, 50, 0, 100, 70, 5])
    expect([...a[0]!.positions]).toEqual([-5, -10, 0, 5, -10, 0, -5, 10, 5])
    // b spans x 100 to 210 and y 50 to 70: centered on 155, 60
    expect([...b[0]!.positions]).toEqual([-55, -10, 0, -45, -10, 0, -55, 10, 5])
  })

  it('gives the same placement when the same parts are centered again, and moves them no further', () => {
    const parts = [tri(100, 50)]
    const first = ID()
    centerObject(parts, [], first, undefined, new Map())
    const again = ID()
    expect(centerObject(parts, [], again, undefined, new Map())).toEqual([105, 60])
    expect(again).toEqual(first)
    expect([...parts[0]!.positions]).toEqual([-5, -10, 0, 5, -10, 0, -5, 10, 5])
  })
})
