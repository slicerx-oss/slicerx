// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { collisionError, collisionMessage, parseCollisions, refusedHits, withObjectIds, type RefusedHit } from '../src/collide'

// sx's own words (packages/core/cli/src/main.rs collision_refusal)
const CROSS = 'sx slice: Paths cross: the prime tower and x-mark-2color-orca.3mf on layers 1 to 56. To fix it: arrange the plate. To slice it anyway, add --allow-collisions.'
const KEEP = 'sx slice: A print path enters the nozzle wrap check corner: c1 on layers 1 to 30. To slice it anyway, add --allow-collisions.'
const GANTRY = 'sx slice: printing by object is not safe: The gantry hits Tower. Tower is 30.0 mm tall, over the 25.0 mm the gantry clears, from layer 31 while Base prints. To fix it: print in the order Tower, Base; or print by layer. To slice it anyway, add --allow-collisions.'

describe('sx collision refusals', () => {
  it('reads crossing paths with the objects and layers', () => {
    const p = parseCollisions(CROSS, ['x-mark-2color-orca.3mf'])
    expect(p?.items).toEqual([{ kind: 'paths_cross', objects: ['the prime tower', 'x-mark-2color-orca.3mf'], first_layer: 1, last_layer: 56 }])
    expect(p?.fixes).toEqual(['arrange the plate'])
  })

  it('keeps a file name that holds " and " whole', () => {
    const p = parseCollisions('sx slice: Paths cross: nut and bolt.stl and washer.stl on layer 4.', ['nut and bolt.stl', 'washer.stl'])
    expect(p?.items[0]).toEqual({ kind: 'paths_cross', objects: ['nut and bolt.stl', 'washer.stl'], first_layer: 4, last_layer: 4 })
  })

  it('reads keep-out zones and by-object clearance', () => {
    expect(parseCollisions(KEEP)?.items).toEqual([{ kind: 'keep_out', zone: 'the nozzle wrap check corner', object: 'c1', first_layer: 1, last_layer: 30 }])
    const g = parseCollisions(GANTRY)
    expect(g?.items[0]).toMatchObject({ kind: 'clearance' })
    expect(g?.fixes).toEqual(['print in the order Tower, Base', 'print by layer'])
  })

  it('reads a keep-out zone in the words sx uses once travels count too', () => {
    const both = 'sx slice: A print path or travel enters the exclusion area: cube.stl on layers 2 to 9. To slice it anyway, add --allow-collisions.'
    expect(parseCollisions(both)?.items).toEqual([{ kind: 'keep_out', zone: 'the exclusion area', object: 'cube.stl', first_layer: 2, last_layer: 9 }])
  })

  it('says it for a person, with no command line flags', () => {
    const p = parseCollisions(CROSS)!
    const msg = collisionMessage(p.items, p.fixes)
    expect(msg).toBe('The prime tower and x-mark-2color-orca.3mf overlap on layers 1 to 56. To fix it, arrange the plate.')
    expect(collisionError(GANTRY)?.message).not.toMatch(/--allow-collisions|sx slice/)
  })

  it('names the objects of each item by id from the refused collisions sx prints', () => {
    const hit = (kind: string, objectId: string, hitId: string, severity = 'hit'): RefusedHit => ({ kind, severity, objectId, hitId })
    const words = 'sx slice: printing by object is not safe: The gantry hits peg.stl. Paths cross: peg.stl and peg.stl on layer 2. Paths cross: peg.stl and the prime tower on layers 1 to 4. A print path or travel enters the exclusion area: peg.stl on layer 1.'
    const items = parseCollisions(words, ['peg.stl'])!.items
    const hits = [hit('hotend', 'o1', 'o0', 'close'), hit('path_conflict', 'o0', 'o1'), hit('gantry', 'o1', 'o0'), hit('path_conflict', 'o1', 'prime-tower'), hit('keep_out', 'o1', 'exclusion-area')]
    const named = withObjectIds(items, hits, [{ id: 'obj-1' }, { id: 'obj-2' }])
    expect(named.map((i) => [i.kind, i.object_ids, i.engine_objects])).toEqual([
      ['clearance', ['obj-2', 'obj-1'], ['o1', 'o0']],
      ['paths_cross', ['obj-1', 'obj-2'], ['o0', 'o1']],
      ['paths_cross', ['obj-2'], ['o1']],
      ['keep_out', ['obj-2'], ['o1']],
    ])
    // A file's objects have the engine's ids only: one request object expands to o0-1, o0-2.
    const file = withObjectIds(items.slice(1, 2), [hit('path_conflict', 'o0-1', 'o0-2')], [{}])
    expect(file[0]).toMatchObject({ engine_objects: ['o0-1', 'o0-2'] })
    expect(file[0]).not.toHaveProperty('object_ids')
    expect(withObjectIds(items.slice(1, 2), [hit('path_conflict', 'o0-1', 'o0-2')], [{ id: 'proj' }])[0]).not.toHaveProperty('object_ids')
  })

  it('reads the refused collisions from stdout, and nothing from an older sx or a result', () => {
    expect(refusedHits('{"refused":"collision","collisions":[{"kind":"gantry","severity":"hit","objectId":"o0","hitId":"o1"}],"collisionFixes":[]}\n')).toEqual([{ kind: 'gantry', severity: 'hit', objectId: 'o0', hitId: 'o1' }])
    expect(refusedHits('')).toBeUndefined()
    expect(refusedHits('{"layerCount":3}')).toBeUndefined()
    const e = collisionError(GANTRY, ['Tower', 'Base'], { hits: [{ kind: 'gantry', severity: 'hit', objectId: 'o1', hitId: 'o0' }], objects: [{ id: 'tower-1' }, { id: 'base-1' }] })
    expect(e?.details).toMatchObject({ collisions: [{ kind: 'clearance', object_ids: ['base-1', 'tower-1'] }] })
    expect(collisionError(GANTRY)?.details).toMatchObject({ collisions: [expect.not.objectContaining({ object_ids: expect.anything() })] })
  })

  it('uses collision for the plate and sequence_clearance for by-object clearance alone', () => {
    const c = collisionError(CROSS)
    expect(c?.code).toBe('collision')
    expect(c?.details).toMatchObject({ allow_collisions: true, collisions: [{ kind: 'paths_cross' }] })
    expect(collisionError(GANTRY)?.code).toBe('sequence_clearance')
    expect(collisionError('sx slice: the model has no triangles')).toBeUndefined()
  })
})
