// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { clearanceRadius, MARGIN_SAFETY_MM, plateMargins } from './arrange-room'

const plate = { origin: [0, 0] as const, size: { widthMm: 256, depthMm: 256 } }

describe('the spacing of a plate printed by object', () => {
  it('is the radius the by-object check holds the printer to', () => {
    // A Bambu Lab printer is held to the larger of its two radii, as heimdall holds it.
    const a1 = { print_sequence: 'by object', printer_model: 'Bambu Lab A1', extruder_clearance_radius: 40, extruder_clearance_max_radius: 73 }
    expect(clearanceRadius(a1)).toBe(73)
    expect(plateMargins(a1, 1, plate).apart).toBe(73 + MARGIN_SAFETY_MM)
    // Other printers keep extruder_clearance_radius.
    const other = { ...a1, printer_model: 'Prusa MK4S', extruder_clearance_radius: 45 }
    expect(plateMargins(other, 1, plate).apart).toBe(45 + MARGIN_SAFETY_MM)
    // By layer there is none.
    expect(plateMargins({ ...a1, print_sequence: 'by layer' }, 1, plate).apart).toBeUndefined()
  })
})
