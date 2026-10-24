// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { keepOutBoxes, keepOutPolygons, clearanceRadius, MARGIN_SAFETY_MM, plateMargins } from './arrange-room'
import { printerConfig } from './index'

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

describe('the keep-out areas of a printer', () => {
  it('are its excluded areas and the corner it runs its nozzle wrap check in', async () => {
    const a1 = (await printerConfig('bambu-a1')) as unknown as Record<string, unknown>
    expect(keepOutBoxes(a1)).toEqual([{ x: 226, y: 224, w: 30, h: 32 }])
    const p1s = (await printerConfig('bambu-p1s')) as unknown as Record<string, unknown>
    expect(keepOutBoxes(p1s)).toEqual([{ x: 0, y: 0, w: 18, h: 28 }])
    const both = { bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'], head_wrap_detect_zone: [[226, 224], [256, 224], [256, 256], [226, 256]] }
    expect(keepOutBoxes(both)).toEqual([{ x: 0, y: 0, w: 18, h: 28 }, { x: 226, y: 224, w: 30, h: 32 }])
    expect(keepOutPolygons(both)).toHaveLength(2)
    expect(keepOutPolygons({})).toEqual([])
  })
})
