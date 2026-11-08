// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
// What a planned size measures, read from its key (@slicerx/contracts/size-kind): a count shows with no unit, an angle in
// degrees, and anything else is a length in the plan's units. An inch plan never converts a count or an angle, and a
// sheet row given in mm reads the same way. Ambiguous keys (walls, taper) stay lengths.
import { describe, expect, it } from 'vitest'
import { dimText, dimUnit, kindOf, sizeKind, sizeLabelKey, sizeText, sizeUnit, wholeCount } from '@slicerx/contracts/size-kind'

describe('sizeKind', () => {
  it('reads a count from its key', () => {
    for (const key of ['count', 'Count', 'number', 'n', 'qty', 'quantity', 'holes', 'teeth', 'segments', 'segment_count', 'holeCount', 'num_teeth', 'n_holes', 'numberOfTeeth', 'count_x', 'sides', 'spokes', 'rows', 'columns', 'copies']) expect(sizeKind(key), key).toBe('count')
  })

  it('reads an angle from its key', () => {
    for (const key of ['angle', 'angle_deg', 'draft', 'twist', 'tilt', 'lean', 'draftAngle', 'lean_deg', 'twist_degrees', 'helix_angle', 'rotation', 'angle_step']) expect(sizeKind(key), key).toBe('angle')
  })

  it('reads everything else as a length', () => {
    for (const key of ['width', 'wall_thickness', 'lipHeight', 'diameter', 'radius', 'pitch', 'tooth_height', 'segment_length', 'total_length', 'count_mm', 'm3-hole', 'x', 'thickness', 'walls', 'taper', '']) expect(sizeKind(key), key).toBe('length')
  })

  const LENGTH_WORDS = ['height', 'width', 'depth', 'length', 'thickness', 'diameter', 'radius', 'size', 'spacing', 'pitch', 'offset', 'gap', 'clearance', 'wall', 'margin', 'inset', 'lip']

  it('reads a key that starts with a count word and ends in a length word as a length', () => {
    for (const key of ['number_height', 'num_depth', 'n_offset', 'count_width', 'number_spacing', 'n_hole_spacing', 'quantity_label_width']) expect(sizeKind(key), key).toBe('length')
    for (const lead of ['number', 'num', 'n', 'count', 'qty']) for (const word of LENGTH_WORDS) expect(sizeKind(`${lead}_${word}`), `${lead}_${word}`).toBe('length')
  })

  it('reads angle_X, two words, as an angle measured by X, unless X is an extent or a count', () => {
    for (const key of ['angle_offset', 'angle_spacing', 'angle_gap', 'angle_pitch', 'angle_step']) expect(sizeKind(key), key).toBe('angle')
    for (const key of ['angle_height', 'angle_thickness']) expect(sizeKind(key), key).toBe('length')
    for (const key of ['angle_segments', 'angle_steps', 'angle_teeth', 'angle_count', 'angle_divisions', 'angle_number']) expect(sizeKind(key), key).toBe('count')
    const steps = new Set(['offset', 'spacing', 'gap', 'pitch'])
    for (const word of LENGTH_WORDS) expect(sizeKind(`angle_${word}`), `angle_${word}`).toBe(steps.has(word) ? 'angle' : 'length')
  })

  it('reads a longer key that starts with angle by its last word, as any other key', () => {
    for (const key of ['angle_leg_length', 'angle_bracket_width', 'angle_bracket_hole_spacing', 'angle_leg_offset', 'angle_bracket_gap', 'angle_hole_pitch']) expect(sizeKind(key), key).toBe('length')
    for (const key of ['angle_bracket_hole_count', 'angle_bracket_holes', 'angle_hole_count', 'angle_bracket_screws']) expect(sizeKind(key), key).toBe('count')
    expect(sizeKind('angle_bracket_lean_deg')).toBe('angle')
  })

  it('lets an explicit mm or in suffix win over every other word', () => {
    for (const key of ['angle_offset_mm', 'angle_spacing_in', 'teeth_mm', 'count_mm', 'draft_angle_mm', 'twist_deg_mm', 'angleBracketWidthMm']) expect(sizeKind(key), key).toBe('length')
    // in anywhere but last is a word of the key, not a unit
    expect(sizeKind('n_in_row')).toBe('count')
  })

  it('leaves turns, coils and loops out of the counts, since a helix or spring often has a fraction of one', () => {
    for (const key of ['turns', 'coils', 'loops']) expect(sizeKind(key), key).toBe('length')
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

describe('dimUnit and dimText', () => {
  it('reads a sheet row given in mm by its key, and keeps degrees and percent as given', () => {
    expect(dimUnit({ key: 'teeth', unit: 'mm' })).toBe('')
    expect(dimUnit({ key: 'draft_angle', unit: 'mm' })).toBe('°')
    expect(dimUnit({ key: 'width', unit: 'mm' })).toBe('mm')
    expect(dimUnit({ key: 'lean', unit: 'deg' })).toBe('°')
    expect(dimUnit({ key: 'infill', unit: '%' })).toBe('%')
    expect(dimText({ key: 'teeth', unit: 'mm' }, 20)).toBe('20')
    expect(dimText({ key: 'lean', unit: 'deg' }, 70)).toBe('70°')
    expect(dimText({ key: 'infill', unit: '%' }, 15)).toBe('15%')
    expect(dimText({ key: 'width', unit: 'mm' }, 80)).toBe('80 mm')
  })
})

describe('wholeCount', () => {
  it('rounds a typed count to a whole number inside the row\'s own bounds, at least 1 by default', () => {
    expect([0, 0.4, 0.5, 2.5, 20.4, -3].map((v) => wholeCount(v))).toEqual([1, 1, 1, 3, 20, 1])
    // a row that allows none keeps 0, and a max of 10.5 keeps the count at 10
    expect(wholeCount(0.3, 0)).toBe(0)
    expect(wholeCount(10.5, 1, 10.5)).toBe(10)
  })
})

/**
 * Real keys and their kinds, from the creative eval recordings (packages/mcp/evals/creative/recordings: plan sizes and
 * sheet rows), the design.check fixture (packages/app/test/fixtures/mimir-check-608-block.json), the scripted plans
 * (packages/app/src/workspaces/mimir/scripts.ts), the plan and sheet tests, and the review cases. Every change to the
 * rules in size-kind.ts must keep this table green: add a row for a new case, never drop or flip one without a reason.
 */
const REAL_KEYS: [string, 'count' | 'angle' | 'length'][] = [
  // counts
  ['count', 'count'], ['teeth', 'count'], ['planet_teeth', 'count'], ['ring_teeth', 'count'], ['sun_teeth', 'count'], ['teeth_small', 'count'],
  ['segment_count', 'count'], ['tail_segments', 'count'], ['fin_count', 'count'], ['link_count', 'count'], ['slot_count', 'count'], ['n_holes', 'count'],
  ['angle_bracket_hole_count', 'count'], ['angle_bracket_holes', 'count'], ['angle_hole_count', 'count'], ['angle_bracket_screws', 'count'], ['angle_segments', 'count'],
  ['angle_steps', 'count'], ['angle_teeth', 'count'], ['angle_count', 'count'], ['angle_divisions', 'count'], ['angle_number', 'count'],
  // angles
  ['lean_deg', 'angle'], ['arc_deg', 'angle'], ['branch_angle', 'angle'], ['countersink_angle', 'angle'], ['pressure_angle', 'angle'], ['angle_deg', 'angle'],
  ['draft', 'angle'], ['angle_offset', 'angle'], ['angle_spacing', 'angle'], ['angle_gap', 'angle'], ['angle_pitch', 'angle'], ['angle_step', 'angle'],
  // lengths
  ['width', 'length'], ['depth', 'length'], ['height', 'length'], ['thickness', 'length'], ['wall', 'length'], ['diameter', 'length'], ['wall_thickness', 'length'],
  ['lipHeight', 'length'], ['case_allowance', 'length'], ['clearance', 'length'], ['axle_diameter', 'length'], ['bore_clearance', 'length'], ['face_width', 'length'],
  ['module', 'length'], ['pitch', 'length'], ['pitch_d_large', 'length'], ['pin_d', 'length'], ['ring_od', 'length'], ['hole_spacing', 'length'], ['rib_spacing', 'length'],
  ['slot_pitch', 'length'], ['slot_pitch_mm', 'length'], ['desk_edge_mm', 'length'], ['wall_mm', 'length'], ['loop_hole', 'length'], ['countersink_head', 'length'],
  ['axis height', 'length'], ['top height', 'length'], ['joint_gap', 'length'], ['knuckle_length', 'length'], ['lip_inward', 'length'], ['cell_across_flats', 'length'],
  ['segment_length', 'length'], ['center_distance', 'length'], ['beam', 'length'], ['span', 'length'], ['floor', 'length'], ['rib', 'length'],
  ['number_height', 'length'], ['n_offset', 'length'], ['count_width', 'length'], ['angle_leg_length', 'length'], ['angle_bracket_width', 'length'],
  ['angle_bracket_hole_spacing', 'length'], ['angle_leg_offset', 'length'], ['angle_bracket_gap', 'length'], ['angle_hole_pitch', 'length'], ['teeth_mm', 'length'],
]

describe('the real keys table', () => {
  it.each(REAL_KEYS)('%s reads as a %s', (key, kind) => {
    expect(sizeKind(key)).toBe(kind)
  })
})

describe('an explicit kind', () => {
  it('beats the key both ways, and the key decides only when no kind is given', () => {
    expect(kindOf('width', 'count')).toBe('count')
    expect(kindOf('teeth', 'length')).toBe('length')
    expect(kindOf('pitch', 'angle')).toBe('angle')
    expect(kindOf('teeth')).toBe('count')
    expect(kindOf('width')).toBe('length')
    for (const [key, kind] of REAL_KEYS) expect(kindOf(key), key).toBe(kind)
  })

  it('sets a sheet row\'s unit over its key, and a length keeps percent', () => {
    expect(dimUnit({ key: 'width', unit: 'mm', kind: 'count' })).toBe('')
    expect(dimUnit({ key: 'teeth', unit: 'mm', kind: 'length' })).toBe('mm')
    expect(dimUnit({ key: 'pitch', unit: 'mm', kind: 'angle' })).toBe('°')
    expect(dimUnit({ key: 'infill', unit: '%', kind: 'length' })).toBe('%')
    expect(dimText({ key: 'width', unit: 'mm', kind: 'count' }, 4)).toBe('4')
    expect(sizeLabelKey('lean_deg', 'angle')).toBe('lean')
  })
})
