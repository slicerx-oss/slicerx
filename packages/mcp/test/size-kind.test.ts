// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a planned size measures, read from its key: a count shows with no unit, an angle in degrees, and anything else is
// a length in the plan's units. An inch plan never converts a count or an angle.
import { describe, expect, it } from 'vitest'
import { sizeKind, sizeLabelKey, sizeText, sizeUnit } from '../src/size-kind'

describe('sizeKind', () => {
  it('reads a count from its key', () => {
    for (const key of ['count', 'Count', 'number', 'n', 'qty', 'teeth', 'segments', 'segment_count', 'holeCount', 'num_teeth', 'n_holes', 'numberOfTeeth', 'count_x', 'sides', 'spokes', 'rows', 'columns', 'copies']) expect(sizeKind(key), key).toBe('count')
  })

  it('reads an angle from its key', () => {
    for (const key of ['angle', 'angle_deg', 'draft', 'twist', 'tilt', 'lean', 'draftAngle', 'lean_deg', 'twist_degrees', 'helix_angle', 'rotation', 'angle_step']) expect(sizeKind(key), key).toBe('angle')
  })

  it('reads everything else as a length', () => {
    for (const key of ['width', 'wall_thickness', 'lipHeight', 'diameter', 'radius', 'pitch', 'tooth_height', 'segment_length', 'total_length', 'count_mm', 'm3-hole', 'x', 'thickness', '']) expect(sizeKind(key), key).toBe('length')
  })
})

describe('sizeUnit and sizeText', () => {
  it('shows a count with no unit and an angle in degrees, in a mm plan', () => {
    expect(sizeUnit(sizeKind('count'), 'mm')).toBe('')
    expect(sizeUnit(sizeKind('angle_deg'), 'mm')).toBe('°')
    expect(sizeUnit(sizeKind('width'), 'mm')).toBe('mm')
    expect(sizeText(sizeKind('count'), 4, 'mm')).toBe('4')
    expect(sizeText(sizeKind('angle_deg'), 30, 'mm')).toBe('30°')
    expect(sizeText(sizeKind('width'), 80, 'mm')).toBe('80 mm')
  })

  it('never converts a count or an angle in an inch plan', () => {
    expect(sizeUnit(sizeKind('teeth'), 'in')).toBe('')
    expect(sizeUnit(sizeKind('draft'), 'in')).toBe('°')
    expect(sizeUnit(sizeKind('width'), 'in')).toBe('in')
    expect(sizeText(sizeKind('teeth'), 20, 'in')).toBe('20')
    expect(sizeText(sizeKind('draft'), 1.5, 'in')).toBe('1.5°')
    expect(sizeText(sizeKind('width'), 3.5, 'in')).toBe('3.5 in')
  })
})

describe('sizeLabelKey', () => {
  it('drops the degree word an angle key ends in, since the unit says it', () => {
    expect(sizeLabelKey('angle_deg')).toBe('angle')
    expect(sizeLabelKey('leanDegrees')).toBe('lean')
    expect(sizeLabelKey('twist-degree')).toBe('twist')
    // a key that is only the unit word, and every other key, stays as it is
    expect(sizeLabelKey('deg')).toBe('deg')
    expect(sizeLabelKey('width_mm')).toBe('width_mm')
    expect(sizeLabelKey('count')).toBe('count')
  })
})
