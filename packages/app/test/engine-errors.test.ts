// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine refuses a malformed model with a short code; people read it as a sentence naming the file, object,
// element and value.
import { describe, expect, it } from 'vitest'
import { engineErrorText } from '../src/lib/engine-errors'

describe('engine refusals in words', () => {
  it('words each 3MF refusal with its file, object, element and value', () => {
    const at = (rest: string) => engineErrorText(`mesh cube.3mf: 3D/3dmodel.model: refused ${rest}`)
    expect(at('index 2 0 8')).toBe('mesh cube.3mf: 3D/3dmodel.model: object 2, triangle 0 names a vertex past its 8 vertices.')
    expect(at('vertex 1 6 oops')).toBe('mesh cube.3mf: 3D/3dmodel.model: object 1, vertex 6: the coordinate "oops" is not a number.')
    expect(at('triangle 2 0 -1')).toBe('mesh cube.3mf: 3D/3dmodel.model: object 2, triangle 0: "-1" is not a vertex number.')
    expect(at('unit 0 0 furlong')).toBe('mesh cube.3mf: 3D/3dmodel.model: the unit "furlong" is not one 3MF defines.')
    expect(at('extension 0 0 https://example.invalid/x')).toContain('requires the 3MF extension https://example.invalid/x')
    expect(at('transform 0 0 1 0 BAD 0 1 0 0 0 1 100 50 0')).toBe(
      'mesh cube.3mf: 3D/3dmodel.model: a build item, the transform "1 0 BAD 0 1 0 0 0 1 100 50 0" is not 12 numbers.',
    )
    expect(at('transform 3 1 1 0 0')).toContain('object 3, the transform "1 0 0"')
    expect(at('id 0 0 two')).toContain('has no usable id ("two")')
  })

  it('words the STL refusals', () => {
    expect(engineErrorText('mesh part.stl: refused stl-empty 0 0 ')).toBe('mesh part.stl: the STL has no triangles.')
    expect(engineErrorText('mesh part.stl: refused stl-number 0 4 ')).toBe('mesh part.stl: triangle 4 of the STL has a coordinate that is not a number.')
    expect(engineErrorText('mesh part.stl: refused stl-cut 0 3 2')).toBe('mesh part.stl: the STL ends inside facet 3, with 2 of its 3 vertices.')
  })

  it('leaves any other message as it is', () => {
    expect(engineErrorText('blocked by the safety preflight: 3 toolpath moves enter an excluded bed area')).toBe(
      'blocked by the safety preflight: 3 toolpath moves enter an excluded bed area',
    )
    expect(engineErrorText('mesh x.3mf: 3D/3dmodel.model: refused novel 0 0 thing')).toBe('mesh x.3mf: 3D/3dmodel.model: refused novel 0 0 thing')
  })
})
