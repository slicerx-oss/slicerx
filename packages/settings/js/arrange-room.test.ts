// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { byObjectApart, clearanceRadius, keepOutBoxes, keepOutPolygons, layoutCenterShift, MARGIN_SAFETY_MM, plateMargins, zoneKeep } from './arrange-room'
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

describe('how far an arrange keeps an outline from a zone', () => {
  it('is the larger of the nest edge and half spacing, and the edge spacing for the box packer', () => {
    // by object the half spacing is half the radius apart
    expect(zoneKeep(0, 0, 6, 74)).toBe(37)
    expect(zoneKeep(0, 0, 6, 74, false)).toBe(6)
    // a brim reaching 8 mm: the edge spacing takes it and the safety
    expect(zoneKeep(8, 8, 6, 0)).toBe(8 + MARGIN_SAFETY_MM)
    expect(zoneKeep(0, 0, 6)).toBe(6)
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

describe('the spacing arrange keeps by object', () => {
  it('is the clearance and the farthest reach of what the objects print round themselves', () => {
    // a 5 mm brim on one part and none on the other: heimdall holds the brim's moves to the radius too
    expect(byObjectApart(74, [5, 0])).toBe(79)
    expect(byObjectApart(74, [])).toBe(74)
    // by layer there is none
    expect(byObjectApart(undefined, [5])).toBeUndefined()
  })
})

describe('moving a finished layout to the middle of the bed', () => {
  const bed = { widthMm: 256, depthMm: 256 }

  it('moves it as a whole, in whole mm cells, so the gantry rule sees the same rows', () => {
    // the layout spans x 10 to 80 and y 20.4 to 170: its middle is 45, 95.2
    const items = [{ box: { x: 10, y: 20.4, w: 20, h: 100 }, reach: 0 }, { box: { x: 60, y: 150, w: 20, h: 20 }, reach: 0 }]
    expect(layoutCenterShift(items, bed)).toEqual([83, 33])
  })

  it('keeps every object and what prints round it on the bed', () => {
    // 250 mm wide with a 3 mm brim: it can go 3 mm right and no further
    expect(layoutCenterShift([{ box: { x: 0, y: 100, w: 250, h: 20 }, reach: 3 }], bed)).toEqual([3, 18])
    // already in the middle
    expect(layoutCenterShift([{ box: { x: 118, y: 118, w: 20, h: 20 }, reach: 0 }], bed)).toEqual([0, 0])
    // the room is 2.6 mm: the whole cells stop at 2
    expect(layoutCenterShift([{ box: { x: 0, y: 0, w: 251.4, h: 251.4 }, reach: 2 }], bed)).toEqual([2, 2])
  })

  it('stays put when an excluded area or a tower room would be in the way, and on a round bed', () => {
    const items = [{ box: { x: 10, y: 10, w: 20, h: 20 }, reach: 0, keep: 2 }]
    expect(layoutCenterShift(items, bed, [{ x: 120, y: 120, w: 10, h: 10 }])).toEqual([0, 0])
    // a zone it does not come near leaves the shift as it is
    expect(layoutCenterShift(items, bed, [{ x: 0, y: 200, w: 30, h: 30 }])).toEqual([108, 108])
    expect(layoutCenterShift(items, { ...bed, round: true })).toEqual([0, 0])
    expect(layoutCenterShift([], bed)).toEqual([0, 0])
  })
})
