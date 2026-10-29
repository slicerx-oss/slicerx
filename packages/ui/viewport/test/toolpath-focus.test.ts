// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A picked collision's focus: the toolpaths fade every bead but one object's in the layers struck, by uniforms only,
// and come back in full when the pick goes.
import { describe, expect, it } from 'vitest'
import { FEATURE, SXPV_OBJECT_NONE, type PreviewBuffers } from '@slicerx/contracts'
import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three'
import { FOCUS_KEEP, Toolpaths } from '../src/toolpaths'
import { buildPreview, type Seg } from './sxpv-fixture'

const seg = (x: number): Seg => ({ a: [x, 0], b: [x + 1, 0], feature: FEATURE.outerWall })

/** Two layers of two segments each, with the per-segment object table the engine writes for a plate of several. */
function withObjects(objects: number[]): PreviewBuffers {
  const b = buildPreview([[seg(0), seg(5)], [seg(0), seg(5)]])
  const at = Math.ceil(b.raw.byteLength / 4) * 4
  const raw = new ArrayBuffer(at + objects.length * 2)
  new Uint8Array(raw).set(new Uint8Array(b.raw))
  new Uint16Array(raw, at, objects.length).set(objects)
  return { ...b, raw, objectsOffset: at }
}

const geometry = (t: Toolpaths) => ((t.root.children.find((c) => (c as Mesh).isMesh && c.name !== 'nozzle') as Mesh).geometry as InstancedBufferGeometry)
const uniforms = (t: Toolpaths) => (t as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms
const versions = (geo: InstancedBufferGeometry) => Object.values(geo.attributes).map((a) => ('data' in a ? (a as InterleavedBufferAttribute).data.version : (a as { version: number }).version))

describe('the toolpaths focus', () => {
  it('fades all but the struck object in the layers struck, and restores them when the pick goes', () => {
    const t = new Toolpaths()
    t.set(withObjects([0, 1, 0, SXPV_OBJECT_NONE]))
    const geo = geometry(t)
    const obj = geo.getAttribute('aObj') as InterleavedBufferAttribute
    expect(Array.from({ length: 4 }, (_, i) => obj.getX(i))).toEqual([0, 1, 0, SXPV_OBJECT_NONE])
    expect(uniforms(t)['uHasObj']!.value).toBe(1)
    const before = versions(geo)
    expect(t.focus).toBeNull()
    expect(t.setFocus({ object: 1, z: [0.2, 0.4] })).toBe(true)
    expect(t.focus).toEqual({ object: 1, z: [0.2, 0.4] })
    expect(uniforms(t)['uFocus']!.value).toBe(1)
    expect(t.setFocus({ object: 1, z: [0.2, 0.4] })).toBe(false)
    // Unpicked: every bead back in full, and no buffer was uploaded again either way.
    expect(t.setFocus(null)).toBe(true)
    expect(t.focus).toBeNull()
    expect(uniforms(t)['uFocus']!.value).toBe(0)
    expect(geometry(t)).toBe(geo)
    expect(versions(geo)).toEqual(before)
  })

  it('keeps every layer of the object when the region gives none, and fades to about a third', () => {
    const t = new Toolpaths()
    t.set(withObjects([0, 1, 0, 1]))
    t.setFocus({ object: 0, z: null })
    expect(t.focus).toEqual({ object: 0, z: null })
    expect(FOCUS_KEEP).toBeCloseTo(0.35)
  })

  it('treats a plate of one object, which has no object table, as all that object', () => {
    const t = new Toolpaths()
    t.set(buildPreview([[seg(0)], [seg(0)]]))
    expect(geometry(t).getAttribute('aObj')).toBeUndefined()
    expect(uniforms(t)['uHasObj']!.value).toBe(0)
    expect(t.setFocus({ object: 0, z: [0.2, 0.2] })).toBe(true)
  })
})
