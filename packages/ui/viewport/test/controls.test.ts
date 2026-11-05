// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { CONTROL_PRESETS, CONTROL_PRESET_IDS, dragMayLeaveBed, dragStartsOnModel, moveWaitsForSlop, orbitCodeFor, pressMovesModel, touchMoveStarted, type PlatePress, resolveDrag, resolveWheel, wheelKind, withRemap, type ControlsPresetId, type Modifiers } from '../src/controls'

const none: Modifiers = { shift: false, ctrl: false, alt: false, space: false }
const wheel = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; shiftKey: boolean }>) => ({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: false, ...o })
const styles: ControlsPresetId[] = ['bambu-studio', 'prusaslicer', 'orcaslicer']

describe('control presets', () => {
  it('has one map per look id, in the install order', () => {
    expect([...CONTROL_PRESET_IDS]).toEqual(['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer'])
    for (const id of CONTROL_PRESET_IDS) expect(CONTROL_PRESETS[id].id).toBe(id)
  })

  it.each(CONTROL_PRESET_IDS)('%s: left rotates, right and middle pan, no binding is ambiguous', (id) => {
    const m = CONTROL_PRESETS[id]
    expect(resolveDrag(m, 'left', none)).toBe('rotate')
    expect(resolveDrag(m, 'right', none)).toBe('pan')
    expect(resolveDrag(m, 'middle', none)).toBe('pan')
    const seen = new Set<string>()
    for (const b of m.drags) {
      const k = `${b.button}|${!!b.mods?.shift}|${!!b.mods?.ctrl}|${!!b.mods?.alt}|${!!b.mods?.space}|${b.context ?? 'any'}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })

  it.each(CONTROL_PRESET_IDS)('%s: wheel zooms toward the cursor and is not inverted', (id) => {
    const m = CONTROL_PRESETS[id]
    expect(m.wheel).toEqual({ invert: false, zoomToCursor: true })
    expect(resolveWheel(m, wheel({}))).toBe('zoom')
    expect(resolveWheel(m, wheel({ ctrlKey: true, deltaY: -2.5 }))).toBe('zoom')
  })

  it('slicerx: space or ctrl with left, shift only in Preview, trackpad scroll pans, orbit around the selection', () => {
    const m = CONTROL_PRESETS.slicerx
    expect(resolveDrag(m, 'left', { ...none, space: true })).toBe('pan')
    expect(resolveDrag(m, 'left', { ...none, ctrl: true })).toBe('rotate')
    expect(resolveDrag(m, 'left', { ...none, shift: true }, 'prepare')).toBe('none')
    expect(resolveDrag(m, 'left', { ...none, shift: true }, 'preview')).toBe('pan')
    expect(resolveDrag(m, 'left', { ...none, alt: true })).toBe('none')
    expect(resolveWheel(m, wheel({ deltaY: 3.5 }))).toBe('pan')
    expect(resolveWheel(m, wheel({ deltaY: 3.5, shiftKey: true }))).toBe('rotate')
    expect(m.orbitAround).toBe('selection')
    expect(m.freeCamera).toBe(false)
    expect(m.doubleClick).toEqual({ empty: 'fit', object: 'zoom' })
  })

  it.each(styles)('%s: shift never moves the camera, scroll zooms, orbit around the scene, model under the cursor moves', (id) => {
    const m = CONTROL_PRESETS[id]
    expect(resolveDrag(m, 'left', { ...none, shift: true })).toBe('none')
    expect(resolveDrag(m, 'left', { ...none, space: true })).toBe('none')
    expect(resolveWheel(m, wheel({ deltaY: 3.5 }))).toBe('zoom')
    expect(m.orbitAround).toBe('scene')
    expect(m.objectDrag).toBe('move-any')
  })

  it('prusaslicer: ctrl with left rotates; the others leave ctrl for multi-select', () => {
    expect(resolveDrag(CONTROL_PRESETS.prusaslicer, 'left', { ...none, ctrl: true })).toBe('rotate')
    expect(resolveDrag(CONTROL_PRESETS['bambu-studio'], 'left', { ...none, ctrl: true })).toBe('none')
    expect(resolveDrag(CONTROL_PRESETS.orcaslicer, 'left', { ...none, ctrl: true })).toBe('none')
  })

  it('rotate speeds follow the research table', () => {
    expect(CONTROL_PRESETS.prusaslicer.rotateSpeed).toBe(1)
    for (const id of ['slicerx', 'bambu-studio', 'orcaslicer'] as const) expect(CONTROL_PRESETS[id].rotateSpeed).toBe(0.8)
  })

  it('labels the imitating presets as a style', () => {
    expect(CONTROL_PRESETS['bambu-studio'].label).toBe('Bambu Studio style')
    expect(CONTROL_PRESETS.prusaslicer.label).toBe('PrusaSlicer style')
    expect(CONTROL_PRESETS.orcaslicer.label).toBe('OrcaSlicer style')
  })
})

describe('object drag', () => {
  it('slicerx moves only a selected model; the styles move any', () => {
    expect(dragStartsOnModel(CONTROL_PRESETS.slicerx, none, 'rotate', false)).toBe(false)
    expect(dragStartsOnModel(CONTROL_PRESETS.slicerx, none, 'rotate', true)).toBe(true)
    expect(dragStartsOnModel(CONTROL_PRESETS['bambu-studio'], none, 'rotate', false)).toBe(true)
  })

  it('a modifier bound to the camera keeps the drag on the camera', () => {
    expect(dragStartsOnModel(CONTROL_PRESETS.slicerx, { ...none, ctrl: true }, 'rotate', true)).toBe(false)
    expect(dragStartsOnModel(CONTROL_PRESETS.slicerx, { ...none, space: true }, 'pan', true)).toBe(false)
    expect(dragStartsOnModel(CONTROL_PRESETS['orcaslicer'], none, 'pan', true)).toBe(false)
  })
})

describe('a press on the plate', () => {
  const finger = (o: Partial<PlatePress> = {}): PlatePress => ({ on: { selected: true }, tool: 'select', mods: none, action: 'rotate', primary: true, ...o })

  it('on a phone, a finger drag on the selected model moves it', () => {
    for (const id of CONTROL_PRESET_IDS) expect(pressMovesModel(finger(), CONTROL_PRESETS[id], 'selected')).toBe(true)
    expect(pressMovesModel(finger({ tool: 'move' }), CONTROL_PRESETS.slicerx, 'selected')).toBe(true)
  })

  it('on a phone, a finger drag on empty space or on a model not selected turns the view, whatever the preset', () => {
    for (const id of CONTROL_PRESET_IDS) {
      expect(pressMovesModel(finger({ on: null }), CONTROL_PRESETS[id], 'selected')).toBe(false)
      expect(pressMovesModel(finger({ on: { selected: false } }), CONTROL_PRESETS[id], 'selected')).toBe(false)
    }
  })

  it('on a phone, a second finger never moves a model, and the rotate and scale tools keep the drag on their handles', () => {
    expect(pressMovesModel(finger({ primary: false }), CONTROL_PRESETS.slicerx, 'selected')).toBe(false)
    for (const tool of ['rotate', 'scale'] as const) expect(pressMovesModel(finger({ tool }), CONTROL_PRESETS.slicerx, 'selected')).toBe(false)
    expect(pressMovesModel(finger({ mods: { ...none, ctrl: true } }), CONTROL_PRESETS.slicerx, 'selected')).toBe(false)
  })

  it('a plate that is only viewed moves nothing', () => {
    expect(pressMovesModel(finger(), CONTROL_PRESETS.slicerx, false)).toBe(false)
    expect(pressMovesModel(finger({ tool: 'move' }), CONTROL_PRESETS.slicerx, false)).toBe(false)
  })

  it('on a desktop, the select tool follows the preset and the move tool drags any model', () => {
    expect(pressMovesModel(finger({ on: { selected: false } }), CONTROL_PRESETS.slicerx, true)).toBe(false)
    expect(pressMovesModel(finger({ on: { selected: false } }), CONTROL_PRESETS['bambu-studio'], true)).toBe(true)
    expect(pressMovesModel(finger({ on: { selected: false }, tool: 'move' }), CONTROL_PRESETS.slicerx, true)).toBe(true)
    expect(pressMovesModel(finger({ on: null }), CONTROL_PRESETS['bambu-studio'], true)).toBe(false)
  })

  it('only a finger on a phone waits for the tap slop; a tablet finger, a pen or a mouse moves the model at once', () => {
    expect(moveWaitsForSlop('touch', 'selected')).toBe(true)
    expect(moveWaitsForSlop('touch', true)).toBe(false)
    expect(moveWaitsForSlop('pen', true)).toBe(false)
    expect(moveWaitsForSlop('mouse', 'selected')).toBe(false)
    expect(moveWaitsForSlop('mouse', true)).toBe(false)
  })

  it('a finger on a phone moves the model on the plate only; its arrows, a tablet finger, a pen or a mouse may take it past an edge', () => {
    expect(dragMayLeaveBed('touch', 'selected')).toBe(false)
    expect(dragMayLeaveBed('touch', true)).toBe(true)
    expect(dragMayLeaveBed('pen', true)).toBe(true)
    expect(dragMayLeaveBed('mouse', true)).toBe(true)
    expect(dragMayLeaveBed('mouse', 'selected')).toBe(true)
  })

  it('a finger that stays within 8 px is a tap or a hold, not a move', () => {
    expect(touchMoveStarted([100, 100], [100, 100])).toBe(false)
    expect(touchMoveStarted([100, 100], [105, 106])).toBe(false)
    expect(touchMoveStarted([100, 100], [109, 100])).toBe(true)
  })
})

describe('withRemap', () => {
  it('replaces the plain binding of a button and keeps modifier bindings', () => {
    const m = withRemap(CONTROL_PRESETS.slicerx, { left: 'pan', right: 'rotate' })
    expect(resolveDrag(m, 'left', none)).toBe('pan')
    expect(resolveDrag(m, 'right', none)).toBe('rotate')
    expect(resolveDrag(m, 'middle', none)).toBe('pan')
    expect(resolveDrag(m, 'left', { ...none, ctrl: true })).toBe('rotate')
    expect(resolveDrag(m, 'left', { ...none, space: true })).toBe('pan')
  })

  it('null clears a button', () => {
    expect(resolveDrag(withRemap(CONTROL_PRESETS.slicerx, { middle: null }), 'middle', none)).toBe('none')
  })

  it('does not change the preset', () => {
    withRemap(CONTROL_PRESETS.slicerx, { left: 'zoom' })
    expect(resolveDrag(CONTROL_PRESETS.slicerx, 'left', none)).toBe('rotate')
  })
})

describe('wheelKind', () => {
  it('tells pinch, trackpad scroll and mouse wheel apart', () => {
    expect(wheelKind(wheel({ ctrlKey: true, deltaY: -1.2 }))).toBe('pinch')
    expect(wheelKind(wheel({ deltaX: 4, deltaY: 2 }))).toBe('scroll')
    expect(wheelKind(wheel({ deltaY: 7 }))).toBe('scroll')
    expect(wheelKind(wheel({ deltaY: 100 }))).toBe('wheel')
    expect(wheelKind(wheel({ deltaY: 3, deltaMode: 1 }))).toBe('wheel')
  })
})

describe('orbitCodeFor', () => {
  it('pre-swaps rotate and pan when OrbitControls will swap them', () => {
    expect(orbitCodeFor('rotate', none)).toBe(0)
    expect(orbitCodeFor('pan', none)).toBe(2)
    expect(orbitCodeFor('pan', { ...none, shift: true })).toBe(0)
    expect(orbitCodeFor('rotate', { ...none, ctrl: true })).toBe(2)
    expect(orbitCodeFor('zoom', { ...none, shift: true })).toBe(1)
    expect(orbitCodeFor('none', none)).toBe(-1)
  })
})
