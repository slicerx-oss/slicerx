// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's gantry in Preview: the beam over the moving head at the rod height, red where it runs through a part
// it strikes, shown on a strike's layers even with the head hidden, with uprights on a bed slinger.
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { Box3, type Mesh, type Object3D } from 'three'
import { Toolpaths } from '../src/toolpaths'
import { buildPreview, type Seg } from './sxpv-fixture'

const A1 = { rod: 25, reach: 56.5, width: 256, slinger: true }
// four layers of 0.2 mm, the nozzle running along y = 128
const seg = (x: number): Seg => ({ a: [x, 128], b: [x + 10, 128], feature: FEATURE.outerWall, tool: 0 })
const preview = buildPreview([0, 1, 2, 3].map(() => [seg(10), seg(20), seg(30)]))
// a part 60 mm tall at x 100 to 156, struck on layers 1 and 2
const HIT = { layers: [1, 2] as [number, number], box: [100, 118, 156, 138] as [number, number, number, number], top: 60 }

function shown(o: Object3D, stop: Object3D): boolean {
  for (let p: Object3D | null = o; p && p !== stop.parent; p = p.parent) if (!p.visible) return false
  return true
}

function rig(): Toolpaths {
  const t = new Toolpaths()
  t.set(preview)
  t.setGantry(A1)
  t.setGantryHits([HIT])
  return t
}

const gantry = (t: Toolpaths) => t.root.getObjectByName('gantry')!
const box = (t: Toolpaths, name: string) => {
  t.root.updateMatrixWorld(true)
  return new Box3().setFromObject(gantry(t).getObjectByName(name)!)
}
const hits = (t: Toolpaths) => gantry(t).children.filter((c) => c.name.startsWith('hit') && c.visible) as Mesh[]

describe('gantry beam', () => {
  it('stands over the moving head at the rod height, across the bed and the band either side of the nozzle', () => {
    const t = rig()
    expect(shown(gantry(t), t.root)).toBe(false)
    t.setRange(0, 0, 2)
    expect(shown(gantry(t), t.root)).toBe(true)
    const b = box(t, 'beam')
    expect(b.min.z).toBeCloseTo(0.2 + 25, 3)
    expect(b.min.y).toBeCloseTo(128 - 56.5, 3)
    expect(b.max.y).toBeCloseTo(128 + 56.5, 3)
    expect(b.min.x).toBeLessThan(0)
    expect(b.max.x).toBeGreaterThan(256)
    // a bed slinger's uprights stand beside the bed at the beam's ends
    expect(box(t, 'upright 0').max.x).toBeLessThanOrEqual(b.min.x + 1e-6)
    expect(box(t, 'upright 1').min.x).toBeGreaterThanOrEqual(b.max.x - 1e-6)
  })

  it('is red through the part only on the strike\'s layers', () => {
    const t = rig()
    t.setRange(0, 0, 2)
    expect(hits(t)).toHaveLength(0)
    t.setRange(0, 1, 2)
    expect(hits(t)).toHaveLength(1)
    const h = new Box3().setFromObject(hits(t)[0]!)
    expect(h.min.x).toBeCloseTo(100 - 0, 0)
    expect(h.max.x).toBeCloseTo(156, 0)
    expect(h.min.z).toBeLessThan(0.4 + 25)
    t.setRange(0, 3, 2)
    expect(hits(t)).toHaveLength(0)
  })

  it('shows on a strike\'s layers with the head hidden, and not elsewhere', () => {
    const t = rig()
    t.setShowToolhead(false)
    t.setRange(0, 0, 2)
    expect(shown(gantry(t), t.root)).toBe(false)
    t.setRange(0, 2, 2)
    expect(shown(gantry(t), t.root)).toBe(true)
  })

  it('draws no uprights for a printer whose bed does not move in y, and nothing without a rod', () => {
    const t = rig()
    t.setGantry({ ...A1, slinger: false })
    t.setRange(0, 0, 2)
    expect(gantry(t).getObjectByName('upright 0')!.visible).toBe(false)
    t.setGantry(null)
    expect(shown(gantry(t), t.root)).toBe(false)
  })
})
