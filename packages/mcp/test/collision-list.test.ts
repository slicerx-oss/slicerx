// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every slice result lists its collisions for a client, refused or sliced anyway: the part struck, where it goes
// deepest and the region struck, on the plate the app shows (from the printable area's front left corner), with the
// plate objects' own ids where the request gave them.
import { describe, expect, it } from 'vitest'
import { collisionError, sliceCollisions, sxCollisions, type SxCollision } from '../src/collide'

const GANTRY = 'sx slice: printing by object is not safe: The gantry hits Tower. Tower is 30.0 mm tall, over the 25.0 mm the gantry clears, from layer 31 while Base prints. To fix it: print in the order Tower, Base; or print by layer. To slice it anyway, add --allow-collisions.'

// sx's own fields, as it writes them (packages/core/src/collide/report.rs Collision)
const gantry: SxCollision = { kind: 'gantry', severity: 'hit', part: 'gantry', objectId: 'o1', hitId: 'o0', damagedId: 'o0', layer: 30, lastLayer: 40, timeS: 812.6, worstPoint: [-58.2, -1.5, 25.2], depthMm: 4.8, limitMm: 25, contactMin: [-60, -10, 25.2], contactMax: [-40, 10, 30] }
const tower: SxCollision = { kind: 'path_conflict', severity: 'hit', part: 'nozzle', objectId: 'o1', hitId: 'prime-tower', damagedId: 'o1', layer: 0, lastLayer: 5, timeS: 30, worstPoint: [0, 0, 0.2], depthMm: 0, contactMin: [-2, -2, 0.2], contactMax: [2, 2, 1.2] }
const close: SxCollision = { kind: 'hotend', severity: 'close', part: 'toolhead', objectId: 'o1', hitId: 'o0', layer: 2, lastLayer: 3, timeS: 50, worstPoint: [10, 10, 3], depthMm: 2.25, limitMm: 40 }

describe('collisions for a client', () => {
  it('reads them from the result sx prints, and none from one without', () => {
    expect(sxCollisions({ layerCount: 3, collisions: [gantry, { kind: 'x' }] })).toEqual([gantry])
    expect(sxCollisions({ layerCount: 3 })).toEqual([])
    expect(sxCollisions(null)).toEqual([])
  })

  it('names the objects by the plate ids, says what is hit and where on the plate, and the region struck', () => {
    // The printable area starts at -128, -128, so the plate's 0, 0 is the machine's -128, -128.
    const list = sliceCollisions([gantry, tower, close], [{ id: 'tower-1', name: 'Tower' }, { id: 'base-1', name: 'Base' }], [-128, -128])
    expect(list[0]).toEqual({
      index: 0,
      kind: 'gantry',
      severity: 'hit',
      part: 'gantry',
      object_id: 'base-1',
      object_name: 'Base',
      hit_id: 'tower-1',
      hit_kind: 'object',
      damaged_id: 'tower-1',
      first_layer: 31,
      last_layer: 41,
      time_s: 813,
      contact_point: [69.8, 126.5, 25.2],
      contact_box: { min: [68, 118, 25.2], max: [88, 138, 30] },
      depth_mm: 4.8,
      limit_mm: 25,
    })
    expect(list[1]).toMatchObject({ index: 1, hit_id: 'prime-tower', hit_kind: 'tower', damaged_id: 'base-1' })
    // A close call hits nothing: no part struck, no region.
    expect(list[2]).toMatchObject({ index: 2, severity: 'close', contact_point: [138, 138, 3] })
    expect(list[2]).not.toHaveProperty('damaged_id')
    expect(list[2]).not.toHaveProperty('contact_box')
  })

  it('keeps the engine ids of objects a project file expands to, and of a request without ids', () => {
    const expanded = sliceCollisions([{ ...gantry, objectId: 'o0-2', hitId: 'o0-1', damagedId: 'o0-1' }], [{ id: 'proj', name: 'plate.3mf' }], [0, 0])
    expect(expanded[0]).toMatchObject({ object_id: 'o0-2', hit_id: 'o0-1', damaged_id: 'o0-1' })
    expect(sliceCollisions([gantry], [{ name: 'Tower' }, { name: 'Base' }], [0, 0])[0]).toMatchObject({ object_id: 'o1', object_name: 'Base', damaged_id: 'o0' })
  })

  it('puts the same list on a refusal, beside the items in words', () => {
    const list = sliceCollisions([gantry], [{ id: 'tower-1' }, { id: 'base-1' }], [0, 0])
    const e = collisionError(GANTRY, ['Tower', 'Base'], { hits: [gantry], objects: [{ id: 'tower-1' }, { id: 'base-1' }], list })
    expect(e?.details).toMatchObject({ collision_list: [{ damaged_id: 'tower-1', contact_box: { min: [-60, -10, 25.2] } }], collisions: [{ kind: 'clearance' }] })
    expect(collisionError(GANTRY)?.details).not.toHaveProperty('collision_list')
  })
})
