// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { scriptDeclarations } from './script-identity'

const selected = { model: 'bambu-p1s', firmware: 'marlin' }

describe('imported script identities', () => {
  it('retains conflicting declarations instead of taking the first name', () => {
    const declarations = scriptDeclarations({ printer_model: ' Bambu Lab P1S ', inherits: ['Bambu Lab A1 0.4 nozzle', 'Unknown printer'] }, selected)
    expect(declarations).toContainEqual(selected)
    expect(declarations).toContainEqual({ model: 'bambu-a1', firmware: 'marlin' })
    expect(declarations).toContainEqual({ model: 'unknown:Unknown printer', firmware: 'marlin' })
  })

  it('does not discard later, empty or invalid firmware declarations', () => {
    for (const gcode_flavor of [['marlin', 'klipper'], [], [7]]) {
      const declarations = scriptDeclarations({ gcode_flavor }, selected)
      expect(declarations.some((identity) => identity.firmware !== selected.firmware)).toBe(true)
    }
    expect(scriptDeclarations({ gcode_flavor: ['marlin', 'marlin'] }, selected)).toEqual([])
  })
})
