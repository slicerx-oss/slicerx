// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { SXPV_FLAG_OBJECTS, SXPV_OBJECT_NONE, objectOfSegment, readPreview } from '@slicerx/contracts'
import { buildPreview } from './sxpv-fixture'

/** The fixture's buffer with one object index per segment appended behind the objects flag. */
function withObjects(objects: number[]): ArrayBuffer {
  const base = buildPreview([[{ a: [0, 0], b: [1, 0], feature: 0 }, { a: [1, 0], b: [2, 0], feature: 15 }], [{ a: [50, 0], b: [51, 0], feature: 6 }]]).raw
  const pad = (objects.length * 2 + 3) & ~3
  const raw = new ArrayBuffer(base.byteLength + pad)
  new Uint8Array(raw).set(new Uint8Array(base))
  const dv = new DataView(raw)
  dv.setUint16(6, dv.getUint16(6, true) | SXPV_FLAG_OBJECTS, true)
  objects.forEach((k, i) => dv.setUint16(base.byteLength + i * 2, k, true))
  return raw
}

describe('object index per segment', () => {
  it('reads the object of each segment, none for the skirt', () => {
    const b = readPreview(withObjects([0, SXPV_OBJECT_NONE, 1]))
    expect(b.objectsOffset).toBeGreaterThan(0)
    expect([0, 1, 2].map((i) => objectOfSegment(b, i))).toEqual([0, -1, 1])
    expect(objectOfSegment(b, 3)).toBe(-1)
  })

  it('reports none for a buffer without the block', () => {
    const b = buildPreview([[{ a: [0, 0], b: [1, 0], feature: 0 }]])
    expect(b.objectsOffset).toBe(-1)
    expect(objectOfSegment(b, 0)).toBe(-1)
  })

  it('refuses a buffer whose block is cut short', () => {
    const raw = withObjects([0, 0, 1])
    expect(() => readPreview(raw.slice(0, raw.byteLength - 4))).toThrow('Truncated')
  })
})
