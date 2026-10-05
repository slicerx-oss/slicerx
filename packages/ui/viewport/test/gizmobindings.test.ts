// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BoxGeometry, Group, Mesh, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { CONTROL_PRESETS, CONTROL_PRESET_IDS, withGizmo } from '../src/controls'
import { BAMBU_GIZMO, ORCA_GIZMO, PRUSA_GIZMO, withGizmoOverrides } from '../src/gizmobindings'
import type { ObjectEntry } from '../src/model'
import { Painter } from '../src/painter'
import type { PaintStroke } from '../src/types'

describe('gizmo bindings per look', () => {
  it('every look carries gizmo bindings, and SlicerX follows Bambu Studio', () => {
    for (const id of CONTROL_PRESET_IDS) expect(CONTROL_PRESETS[id].gizmo).toBeTruthy()
    expect(CONTROL_PRESETS.slicerx.gizmo).toEqual(BAMBU_GIZMO)
    expect(CONTROL_PRESETS['bambu-studio'].gizmo).toEqual(BAMBU_GIZMO)
    expect(CONTROL_PRESETS.orcaslicer.gizmo).toEqual(ORCA_GIZMO)
    expect(CONTROL_PRESETS.prusaslicer.gizmo).toEqual(PRUSA_GIZMO)
  })

  describe('scale, from GLGizmoScale.cpp (Orca, Bambu Studio) and ScaleGizmo.cpp (PrusaSlicer 3.0)', () => {
    it('Bambu Studio: Ctrl pins the opposite handle live, Shift snaps 5 percent, corners ignore the pin', () => {
      const s = BAMBU_GIZMO.scale
      expect(s).toMatchObject({ layout: 'bottom', pivot: 'bottom-center', pinKey: 'ctrl', pinMode: 'live', cornerPinLocksZ: false, snapKey: 'shift', snapStep: 0.05, ratio: 'point', independentKey: null })
    })
    it('Orca: Ctrl read at the drag start, the ray meets the handle plane, a pinned corner scales x and y only, Alt is independent', () => {
      const s = ORCA_GIZMO.scale
      expect(s).toMatchObject({ layout: 'bottom', pivot: 'bottom-center', pinKey: 'ctrl', pinMode: 'at-start', cornerPinLocksZ: true, snapKey: 'shift', snapStep: 0.05, ratio: 'plane', independentKey: 'alt' })
    })
    it('PrusaSlicer: face handles, scales about the center, no modifier keys, at least 1 mm', () => {
      const s = PRUSA_GIZMO.scale
      expect(s).toMatchObject({ layout: 'faces', pivot: 'center', pinKey: null, snapKey: null, ratio: 'line', minSizeMm: 1, independentKey: null })
    })
  })

  describe('move', () => {
    it('Orca and Bambu Studio snap to 1 mm with Shift; PrusaSlicer does not snap', () => {
      expect(BAMBU_GIZMO.move).toEqual({ snapKey: 'shift', snapStepMm: 1 })
      expect(ORCA_GIZMO.move).toEqual({ snapKey: 'shift', snapStepMm: 1 })
      expect(PRUSA_GIZMO.move.snapKey).toBeNull()
    })
  })

  describe('paint, from GLGizmoPainterBase.cpp, TriangleSelector.cpp and PaintOnGizmoBase.cpp', () => {
    it('Bambu Studio: Ctrl wheel parameters, Alt wheel clipping, right button to the camera, edge detail capped at 0.2', () => {
      const p = BAMBU_GIZMO.paint
      expect(p).toMatchObject({ eraseKey: 'shift', colorRightButton: 'camera', wheelParamKey: 'ctrl', wheelClipKey: 'alt', detail: { divisor: 5, cap: 0.2 } })
      expect(p.radius).toEqual({ default: 1, min: 0.4, max: 8, step: 0.2 })
      expect(p.height).toEqual({ anchor: 'bottom', default: 0.2, min: 0.1, max: 8, step: 0.2 })
      expect(p.angle).toEqual({ smart: 30, bucket: 30, shared: true, min: 0, max: 90, step: 1 })
      expect(p.gapArea).toEqual({ default: 0, min: 0, max: 5, step: 0.2 })
      expect(p.tools).toContain('gap')
    })
    it('Orca differs from Bambu Studio in the edge detail cap, 0.05 against 0.2', () => {
      expect(ORCA_GIZMO.paint.detail).toEqual({ divisor: 5, cap: 0.05 })
      expect({ ...ORCA_GIZMO.paint, detail: BAMBU_GIZMO.paint.detail }).toEqual(BAMBU_GIZMO.paint)
    })
    it('PrusaSlicer: Alt wheel parameters, Ctrl wheel clipping, right button paints the second color, band centered, no gap fill, color replace', () => {
      const p = PRUSA_GIZMO.paint
      expect(p).toMatchObject({ eraseKey: 'shift', colorRightButton: 'second-state', wheelParamKey: 'alt', wheelClipKey: 'ctrl', detail: { divisor: 5, cap: null }, gapArea: null })
      expect(p.radius.default).toBe(2)
      expect(p.height).toEqual({ anchor: 'center', default: 1, min: 0.1, max: 10, step: 0.1 })
      expect(p.angle).toMatchObject({ smart: 30, bucket: 90, shared: false })
      expect(p.tools).toContain('replace')
      expect(p.tools).not.toContain('gap')
    })
  })
})

describe('gizmo overrides', () => {
  it('merges nested edits and leaves the preset alone', () => {
    const out = withGizmoOverrides(BAMBU_GIZMO, { scale: { snapKey: 'alt', snapStep: 0.1 }, paint: { radius: { default: 3 }, eraseKey: null } })
    expect(out.scale.snapKey).toBe('alt')
    expect(out.scale.snapStep).toBe(0.1)
    expect(out.scale.pinKey).toBe('ctrl')
    expect(out.paint.radius).toEqual({ default: 3, min: 0.4, max: 8, step: 0.2 })
    expect(out.paint.eraseKey).toBeNull()
    expect(BAMBU_GIZMO.scale.snapKey).toBe('shift')
    expect(BAMBU_GIZMO.paint.eraseKey).toBe('shift')
  })

  it('can clear an optional tool and replace the tool list', () => {
    const out = withGizmoOverrides(BAMBU_GIZMO, { paint: { gapArea: null, tools: ['brush', 'fill'] } })
    expect(out.paint.gapArea).toBeNull()
    expect(out.paint.tools).toEqual(['brush', 'fill'])
  })

  it('applies to a controls map through withGizmo, keeping the camera bindings', () => {
    const m = withGizmo(CONTROL_PRESETS['orcaslicer'], { move: { snapKey: null } })
    expect(m.gizmo.move.snapKey).toBeNull()
    expect(m.drags).toBe(CONTROL_PRESETS['orcaslicer'].drags)
    expect(CONTROL_PRESETS['orcaslicer'].gizmo.move.snapKey).toBe('shift')
  })
})

function painterFor(id: keyof typeof CONTROL_PRESETS): { painter: Painter; strokes: PaintStroke[] } {
  const strokes: PaintStroke[] = []
  const painter = new Painter(() => undefined, new Group(), () => {}, (s) => strokes.push(s), () => CONTROL_PRESETS[id].gizmo.paint)
  painter.applyPreset()
  return { painter, strokes }
}

describe('painter follows the bindings', () => {
  it('starts from the look defaults', () => {
    expect(painterFor('orcaslicer').painter.settings).toMatchObject({ radiusMm: 1, heightMm: 0.2, angleDeg: 30, fillAngleDeg: 30 })
    expect(painterFor('prusaslicer').painter.settings).toMatchObject({ radiusMm: 2, heightMm: 1, angleDeg: 30, fillAngleDeg: 90 })
  })

  it('the wheel changes the radius in the look steps and stops at its limits', () => {
    const { painter } = painterFor('orcaslicer')
    painter.wheel(1, 'param')
    expect(painter.settings.radiusMm).toBeCloseTo(1.2)
    for (let i = 0; i < 100; i++) painter.wheel(1, 'param')
    expect(painter.settings.radiusMm).toBe(8)
    for (let i = 0; i < 100; i++) painter.wheel(-1, 'param')
    expect(painter.settings.radiusMm).toBe(0.4)
  })

  it('the height tool takes the height steps of the look', () => {
    const o = painterFor('orcaslicer').painter
    o.update({ tool: 'height' })
    o.wheel(1, 'param')
    expect(o.settings.heightMm).toBeCloseTo(0.4)
    const p = painterFor('prusaslicer').painter
    p.update({ tool: 'height' })
    p.wheel(1, 'param')
    expect(p.settings.heightMm).toBeCloseTo(1.1)
    for (let i = 0; i < 200; i++) p.wheel(1, 'param')
    expect(p.settings.heightMm).toBe(10)
  })

  it('Orca shares one angle between smart and bucket fill; PrusaSlicer keeps two', () => {
    const o = painterFor('orcaslicer').painter
    o.update({ tool: 'smart' })
    o.wheel(1, 'param')
    expect([o.settings.angleDeg, o.settings.fillAngleDeg]).toEqual([31, 31])
    const p = painterFor('prusaslicer').painter
    p.update({ tool: 'smart' })
    p.wheel(-1, 'param')
    expect([p.settings.angleDeg, p.settings.fillAngleDeg]).toEqual([29, 90])
    p.update({ tool: 'fill' })
    p.wheel(1, 'param')
    expect([p.settings.angleDeg, p.settings.fillAngleDeg]).toEqual([29, 90])
    p.wheel(-1, 'param')
    expect(p.settings.fillAngleDeg).toBe(89)
  })

  it('gap area steps 0.2 up to 5 where the look has gap fill, and a look without it ignores the tool', () => {
    const o = painterFor('orcaslicer').painter
    o.update({ tool: 'gap' })
    o.wheel(1, 'param')
    expect(o.settings.gapAreaMm2).toBeCloseTo(0.2)
    for (let i = 0; i < 100; i++) o.wheel(1, 'param')
    expect(o.settings.gapAreaMm2).toBe(5)
    const p = painterFor('prusaslicer').painter
    p.update({ tool: 'gap' })
    expect(p.settings.tool).toBe('brush')
    p.update({ tool: 'replace' })
    expect(p.settings.tool).toBe('replace')
  })

  it('the clip wheel moves the plane by 0.01 and the plane hides what lies in front of it', () => {
    const { painter } = painterFor('orcaslicer')
    const cam = new PerspectiveCamera()
    cam.position.set(0, 0, 100)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    const group = new Group()
    group.add(new Mesh(new BoxGeometry(20, 20, 20)))
    const entry = { id: 'a', name: 'a', group, parts: [] } as unknown as ObjectEntry
    expect(painter.clipPlane()).toBeNull()
    painter.wheel(1, 'clip', cam, entry)
    expect(painter.settings.clipRatio).toBeCloseTo(0.01)
    // Nearly off: only points in front of the bounding sphere's front edge are clipped.
    expect(painter.isClipped(new Vector3(0, 0, 10))).toBe(false)
    for (let i = 0; i < 49; i++) painter.wheel(1, 'clip', cam, entry)
    expect(painter.settings.clipRatio).toBeCloseTo(0.5)
    // Halfway, the plane passes through the model's center: the front half is gone.
    expect(painter.isClipped(new Vector3(0, 0, 5))).toBe(true)
    expect(painter.isClipped(new Vector3(0, 0, -5))).toBe(false)
    const plane = painter.clipPlane()
    expect(plane).not.toBeNull()
    expect((plane as NonNullable<typeof plane>).distanceToPoint(new Vector3(0, 0, -5))).toBeGreaterThan(0)
    expect((plane as NonNullable<typeof plane>).distanceToPoint(new Vector3(0, 0, 5))).toBeLessThan(0)
    painter.setClip(0, null, null)
    expect(painter.clipPlane()).toBeNull()
    expect(painter.isClipped(new Vector3(0, 0, 50))).toBe(false)
  })

  it('PrusaSlicer swaps the keys: Alt is the parameter key and Ctrl the clip key', () => {
    const b = PRUSA_GIZMO.paint
    expect([b.wheelParamKey, b.wheelClipKey]).toEqual(['alt', 'ctrl'])
    expect([ORCA_GIZMO.paint.wheelParamKey, ORCA_GIZMO.paint.wheelClipKey]).toEqual(['ctrl', 'alt'])
  })
})
