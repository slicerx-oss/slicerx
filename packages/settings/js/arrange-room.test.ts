// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { betterNest, byObjectApart, byObjectSpacing, byObjectSpacingModes, clearanceRadius, KEEP_OUT_GAP_MM, keepOutBoxes, keepOutPolygons, layoutCenterShift, MARGIN_SAFETY_MM, nestProblem, plateMargins, shiftKeep, zoneKeep, type NestItem, type NestMargins } from './arrange-room'
import { printerConfig } from './index'
import { settingDefault } from './defaults'
import { settingNumber } from './print-margins'

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

describe('each by-object pair spaced by its own two parts', () => {
  it('spaces pairs by the farthest reach or by each part\u2019s own, both keeping what the check needs', () => {
    expect(byObjectSpacing(41, [0, 0, 0, 7.9], 'own')).toEqual({ apartMm: 41, extra: [0, 0, 0, 7.9] })
    expect(byObjectSpacing(41, [0, 0, 0, 7.9])).toEqual({ apartMm: 48.9, extra: [0, 0, 0, 0] })
    expect(byObjectSpacing(41, [0, 0])).toEqual({ apartMm: 41, extra: [0, 0] })
    // Either way every pair keeps the clearance and the larger of its two reaches, as the check holds it.
    for (const r of [[0, 3, 9], [2, 2, 8, 0], [5, 5, 5], [0, 7.9], [1, 6.2, 6.2, 0, 0]]) {
      for (const mode of ['own', 'farthest'] as const) {
        const s = byObjectSpacing(41, r, mode)
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(s.apartMm + s.extra[i]! + s.extra[j]!).toBeGreaterThanOrEqual(41 + Math.max(r[i]!, r[j]!))
      }
    }
    // Both are tried only when the reaches differ.
    expect(byObjectSpacingModes([0, 0, 7.9])).toEqual(['own', 'farthest'])
    expect(byObjectSpacingModes([0, 0])).toEqual(['farthest'])
    expect(byObjectSpacingModes([7.9, 7.9])).toEqual(['farthest'])
    const reply = (placed: number, utilization: number) => ({ placements: [], leftOver: [], tooLarge: [], stats: { placed, wanted: 9, passes: 1, utilization } })
    expect(betterNest(reply(8, 0.5), reply(9, 0.1)).stats.placed).toBe(9)
    expect(betterNest(reply(9, 0.2), reply(9, 0.3)).stats.utilization).toBe(0.3)
  })

  it('sends the nest the share of each part, from the reach the check counts over the plate-wide one', () => {
    const item = (id: string, apartReach: number): NestItem => ({ id, polygons: [], hull: [], grow: 0, reach: 7.9, copies: 1, apartReach })
    const margins = { grow: () => 0, reach: () => 7.9, skirt: false, apart: 41 }
    const p = nestProblem({ bed: { widthMm: 256, depthMm: 256 }, items: [item('a', 0), item('b', 0), item('l', 7.9)], fixed: [item('f', 0)], avoid: [], towers: [], margins, gapMm: 6, rotate: false, center: true, spacing: 'own' })
    expect(p.options.apartMm).toBe(41)
    expect(p.items.map((i) => ('apartExtra' in i ? i.apartExtra : 0))).toEqual([0, 0, 7.9])
    expect(p.items.some((i) => 'apartReach' in i)).toBe(false)
    expect('apartExtra' in p.fixed[0]!).toBe(false)
    // Spaced by the farthest, every pair keeps the farthest reach the check counts: the cubes reach nothing.
    const far = nestProblem({ bed: { widthMm: 256, depthMm: 256 }, items: [item('a', 0), item('b', 0)], fixed: [], avoid: [], towers: [], margins, gapMm: 6, rotate: false, center: true })
    expect(far.options.apartMm).toBe(41)
    // Without the check's reach, every pair keeps the plate-wide reach, as before.
    const plain = nestProblem({ bed: { widthMm: 256, depthMm: 256 }, items: [{ id: 'a', polygons: [], hull: [], grow: 0, reach: 7.9, copies: 1 }], fixed: [], avoid: [], towers: [], margins, gapMm: 6, rotate: false, center: true })
    expect(plain.options.apartMm).toBeCloseTo(48.9, 6)
  })
})

describe("the nest request for the printer's keep-out areas", () => {
  const margins: NestMargins = { grow: () => 0, reach: () => 0, skirt: false }
  // the A1's wrap check corner, then a gantry lane
  const base = { bed: { widthMm: 256, depthMm: 256 }, items: [], fixed: [], avoid: [{ x: 226, y: 224, w: 30, h: 32 }, { x: 0, y: 100, w: 256, h: 40 }], towers: [], gapMm: 6, rotate: false, center: true }

  it('names them printing by object, so they keep the edge spacing there', () => {
    const r = nestProblem({ ...base, keepOut: 1, margins: { ...margins, apart: 74 } })
    expect(r.options).toMatchObject({ apartMm: 74, keepOutZones: 1 })
    expect(r.zones).toHaveLength(2)
  })

  it('leaves a by-layer request as it was', () => {
    const r = nestProblem({ ...base, keepOut: 1, margins })
    expect(r.options).not.toHaveProperty('keepOutZones')
    expect(JSON.stringify(r)).toBe(JSON.stringify(nestProblem({ ...base, margins })))
  })

  it('keeps a layout moved to the middle as far from them as the nest keeps a part', () => {
    expect(shiftKeep(0, 0)).toBe(KEEP_OUT_GAP_MM)
    expect(shiftKeep(0, 7.5)).toBe(7.5 + MARGIN_SAFETY_MM)
    // two bare 230 x 58 mm brackets in lanes on an A1: moved to the middle, the back one would end 0.6 mm in front of
    // the wrap check corner, so the layout stays where the nest put it
    const boxes = [{ x: 13, y: 6, w: 230, h: 58 }, { x: 13, y: 138.4, w: 230, h: 58 }]
    const corner = { x: 226, y: 224, w: 30, h: 32 }
    const bed = { widthMm: 256, depthMm: 256 }
    expect(layoutCenterShift(boxes.map((box) => ({ box, reach: 0, keep: 0 })), bed, [corner])).toEqual([0, 27])
    expect(layoutCenterShift(boxes.map((box) => ({ box, reach: 0, keep: shiftKeep(0, 0) })), bed, [corner])).toEqual([0, 0])
  })
})

describe('a prime tower whose width the config leaves out', () => {
  // sx prints it at the schema default (its PrintConfig::default reads the same defaults.json), so arrange keeps that much.
  it('takes the room of the schema default width', () => {
    const plate = { origin: [0, 0] as const, size: { widthMm: 256, depthMm: 256 } }
    const room = (cfg: Record<string, unknown>) => plateMargins({ enable_prime_tower: true, prime_tower_auto_position: false, ...cfg } as never, 2, plate).keepOut
    expect(settingNumber({}, 'prime_tower_width')).toBe(settingDefault('prime_tower_width'))
    expect(room({})).toEqual(room({ prime_tower_width: settingDefault('prime_tower_width') }))
    expect(room({})[0]!.w).toBeCloseTo(Number(settingDefault('prime_tower_width')) + 2 * (3 + MARGIN_SAFETY_MM), 9)
  })
})
