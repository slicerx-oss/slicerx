// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine refuses a malformed model with a short code; people read it as a sentence naming the file, object,
// element and value.
import { describe, expect, it } from 'vitest'
import { capitalized, engineErrorText } from '../src/lib/engine-errors'

describe('engine refusals in words', () => {
  it('words each 3MF refusal with its file, object, element and value', () => {
    const at = (rest: string) => engineErrorText(`mesh cube.3mf: 3D/3dmodel.model: refused ${rest}`)
    expect(at('index 2 0 8')).toBe('Mesh cube.3mf: 3D/3dmodel.model: object 2, triangle 0 names a vertex past its 8 vertices.')
    expect(at('vertex 1 6 oops')).toBe('Mesh cube.3mf: 3D/3dmodel.model: object 1, vertex 6: the coordinate "oops" is not a number.')
    expect(at('triangle 2 0 -1')).toBe('Mesh cube.3mf: 3D/3dmodel.model: object 2, triangle 0: "-1" is not a vertex number.')
    expect(at('unit 0 0 furlong')).toBe('Mesh cube.3mf: 3D/3dmodel.model: the unit "furlong" is not one 3MF defines.')
    expect(at('extension 0 0 https://example.invalid/x')).toContain('requires the 3MF extension https://example.invalid/x')
    expect(at('transform 0 0 1 0 BAD 0 1 0 0 0 1 100 50 0')).toBe(
      'Mesh cube.3mf: 3D/3dmodel.model: a build item, the transform "1 0 BAD 0 1 0 0 0 1 100 50 0" is not 12 numbers.',
    )
    expect(at('transform 3 1 1 0 0')).toContain('object 3, the transform "1 0 0"')
    expect(at('id 0 0 two')).toContain('has no usable id ("two")')
  })

  it('words the STL refusals', () => {
    expect(engineErrorText('mesh part.stl: refused stl-empty 0 0 ')).toBe('Mesh part.stl: the STL has no triangles.')
    expect(engineErrorText('mesh part.stl: refused stl-number 0 4 ')).toBe('Mesh part.stl: triangle 4 of the STL has a coordinate that is not a number.')
    expect(engineErrorText('mesh part.stl: refused stl-cut 0 3 2')).toBe('Mesh part.stl: the STL ends inside facet 3, with 2 of its 3 vertices.')
  })

  it('leaves the wording of any other message as it is', () => {
    expect(engineErrorText('Blocked by the safety preflight: 3 toolpath moves enter an excluded bed area')).toBe('Blocked by the safety preflight: 3 toolpath moves enter an excluded bed area')
    expect(engineErrorText('Mesh x.3mf: 3D/3dmodel.model: refused novel 0 0 thing')).toBe('Mesh x.3mf: 3D/3dmodel.model: refused novel 0 0 thing')
  })

  it('opens a line with a capital letter and leaves the rest, and file names and codes, alone', () => {
    // The engine words its safety refusals in lowercase; the app shows them as a line of its own.
    expect(engineErrorText('blocked by the safety preflight: toolpaths lie outside the printable area from layer 3 (X-4.2 Y120.0, brim of "cube")')).toBe(
      'Blocked by the safety preflight: toolpaths lie outside the printable area from layer 3 (X-4.2 Y120.0, brim of "cube")',
    )
    expect(capitalized('layers reach above the printable height')).toBe('Layers reach above the printable height')
    expect(capitalized('Already fine')).toBe('Already fine')
    expect(capitalized('cube.3mf: not a model')).toBe('cube.3mf: not a model')
    expect(capitalized('x1: odd')).toBe('x1: odd')
    expect(capitalized('')).toBe('')
  })
})
