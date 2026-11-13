// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small part in the same filament as the part it sits on hardly shows (a white boat on a white deck). design.check
// notes it for a display or fine model, beside the check: never a failed item. A check that passes asks the reply
// to pass the note on.
import { describe, expect, it } from 'vitest'
import { colorInPlay, createPlanRegistry, designCheck, NOTES_SAY, SAME_FILAMENT, sameFilament, SITS_MM, SMALL_SHARE, type BodyFacts, type PartBox, type PartPlan } from '../src/design-check'
import { useGeomEngine } from './geom-engine'
import { connect, data, text } from './helpers'

type V3 = [number, number, number]
const box = (name: string, slot: number, min: V3, max: V3, painted = false): PartBox => ({ name, slot, painted, min, max })
const deck = box('Deck', 2, [0, 0, 0], [100, 30, 10])
const boat = (slot: number, z = 10, painted = false) => box('Boat', slot, [40, 10, z], [50, 16, z + 4], painted)

describe('a small part in the filament of what it sits on', () => {
  it('is asked of the reply in one sentence that carries every note', () => {
    expect(NOTES_SAY(['A is red.', 'B is blue. Paint it.'])).toBe('Say this in the reply too, as a suggestion: A is red; B is blue. Paint it')
  })

  it('is noted, naming both parts and the filament', () => {
    expect(sameFilament([deck, boat(2)])).toEqual(["Boat is the same filament (2) as Deck, which it sits on, so it will hardly show. Give it another filament, or paint Deck under it."])
    expect(SAME_FILAMENT('Boat', 'Deck', 2)).toBe(sameFilament([deck, boat(2)])[0])
  })

  it('says a part with the name a new body gets in words', () => {
    expect(sameFilament([{ ...deck, name: 'Body' }, boat(2)])).toEqual(['Boat is the same filament (2) as the part it sits on, so it will hardly show. Give it another filament, or paint that part under it.'])
    expect(sameFilament([deck, { ...boat(2), name: 'Body 2' }])).toEqual(['A small part is the same filament (2) as Deck, which it sits on, so it will hardly show. Give it another filament, or paint Deck under it.'])
  })

  it('counts a part sunk into the one under it, or set a hair above it, as sitting on it', () => {
    expect(sameFilament([deck, boat(2, 9.95)])).toHaveLength(1)
    expect(sameFilament([deck, boat(2, 10 + SITS_MM - 0.01)])).toHaveLength(1)
    expect(sameFilament([deck, boat(2, 10 + SITS_MM + 0.1)])).toEqual([])
  })

  it('leaves out another filament, a part beside it, a large part, and paint on either', () => {
    expect(sameFilament([deck, boat(3)])).toEqual([])
    expect(sameFilament([deck, box('Boat', 2, [120, 10, 0], [130, 16, 4])])).toEqual([])
    // a deck house over a third of the deck is not small beside it
    expect(SMALL_SHARE).toBe(0.25)
    expect(sameFilament([deck, box('House', 2, [10, 0, 10], [50, 30, 20])])).toEqual([])
    expect(sameFilament([deck, boat(2, 10, true)])).toEqual([])
    expect(sameFilament([{ ...deck, painted: true }, boat(2)])).toEqual([])
  })

  it('takes the highest part under it: a boat on a white deck over a black hull', () => {
    const hull = box('Hull', 1, [0, 0, -20], [100, 30, 0])
    expect(sameFilament([hull, deck, boat(2)])).toHaveLength(1)
    expect(sameFilament([hull, deck, boat(1)])).toEqual([])
  })
})

const plan = (detail?: 'display' | 'fine'): PartPlan => ({
  planId: 'ship-1',
  part: 'Ship',
  units: 'mm',
  features: [{ name: 'Deck', kind: 'extrude', sizes: { width: 100, depth: 30, height: 10 } }],
  holes: [],
  assumptions: [],
  questions: [],
  ...(detail ? { detail } : {}),
} as PartPlan)

describe('design.check notes it for a display or fine model only, never as a failed item', () => {
  // a white deck with a black hull under it: two filaments, so color is in play
  const hull = box('Hull', 1, [0, 0, -20], [100, 30, 0])
  const body: BodyFacts = { size: { x: 100, y: 34, z: 34 }, holes: [], features: 3, watertight: true, minWallMm: 2, partBoxes: [hull, deck, boat(2)] }
  it('adds the note beside the items, which stay as they were', () => {
    const plain = designCheck(plan(), body, 0.4)
    expect(plain.notes).toBeUndefined()
    for (const d of ['display', 'fine'] as const) {
      const r = designCheck(plan(d), body, 0.4)
      expect(r.notes).toEqual([SAME_FILAMENT('Boat', 'Deck', 2)])
      expect(r.items.every((i) => !i.warning?.includes('hardly show'))).toBe(true)
    }
    expect(designCheck(plan('display'), { ...body, partBoxes: [hull, deck, boat(3)] }, 0.4).notes).toBeUndefined()
  })

  it('says nothing on a one filament build nobody asked color of, even with the boat on the deck', () => {
    const one: BodyFacts = { ...body, partBoxes: [{ ...hull, slot: 2 }, deck, boat(2)] }
    expect(colorInPlay(one.partBoxes!)).toBe(false)
    expect(designCheck(plan('display'), one, 0.4).notes).toBeUndefined()
  })

  it('counts color in play from what the design has: a second filament or color paint, never the plan alone', () => {
    const one = [deck, boat(2)]
    expect(colorInPlay(one)).toBe(false)
    // a plan that gives colors adds nothing while the design is one filament
    expect(designCheck({ ...plan('display'), colors: { Deck: 'white', Boat: 'white' } }, { ...body, partBoxes: one }, 0.4).notes).toBeUndefined()
    expect(colorInPlay([hull, ...one])).toBe(true)
    // paint anywhere puts color in play; the painted part itself is still left out of the note
    expect(colorInPlay([{ ...hull, slot: 2, painted: true }, ...one])).toBe(true)
    expect(designCheck(plan('display'), { ...body, partBoxes: [{ ...hull, slot: 2, painted: true }, ...one] }, 0.4).notes).toEqual([SAME_FILAMENT('Boat', 'Deck', 2)])
  })
})

type Check = { pass: boolean; notes?: string[]; items: { name: string; pass: boolean; warning?: string }[]; body: BodyFacts }

const geom = useGeomEngine('same-filament-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('slicerx_design_check on a display deck with a boat in its filament', () => {
  /** A deck in filament 1 with a boat on it in filament 1, sunk 0.05 mm into it, and with `flag` a flag on it in filament 2. */
  async function ship(flag: boolean) {
    const plans = createPlanRegistry()
    const h = await connect({ geomEngine: engine, plans })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return r
    }
    const design = data<{ output: { design: string } }>(await ok('slicerx_design_new', { name: 'Ship' })).output.design
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 100, heightMm: 30 }, placement: { center: [50, 15] }, distance_mm: 10, feature: 'Deck' })
    await ok('slicerx_geom_build', { design, name: 'Boat', slot: 1, solids: [{ type: 'box', min: [40, 10, 9.95], max: [50, 16, 14] }] })
    if (flag) await ok('slicerx_geom_build', { design, name: 'Flag', slot: 2, solids: [{ type: 'box', min: [80, 14, 9.95], max: [82, 16, 20] }] })
    plans.put(plan('display'), design, 'card')
    return data<{ summary: string; output: Check }>(await ok('slicerx_design_check', { planId: 'ship-1' }))
  }

  it('says nothing when the whole ship is one filament and the plan asks no color', async () => {
    const out = await ship(false)
    expect(out.summary).not.toContain('Say this in the reply too')
    expect(out.output.body.partBoxes?.map((b) => [b.name, b.slot])).toEqual([['Body', 1], ['Boat', 1]])
    expect(out.output.notes).toBeUndefined()
  })

  it('notes the boat once a second filament is in play, and the passing summary says to pass it on', async () => {
    const out = await ship(true)
    expect(out.output.body.partBoxes?.map((b) => [b.name, b.slot])).toEqual([['Body', 1], ['Boat', 1], ['Flag', 2]])
    expect(out.output.notes).toEqual([SAME_FILAMENT('Boat', undefined, 1)])
    // the check passes, so its summary asks the reply to pass the note on, after the size and the resize offer
    expect(out.output.pass).toBe(true)
    expect(out.summary.endsWith(`offer a resize as a follow-up: half size, or a length the person types. ${NOTES_SAY(out.output.notes!)}`)).toBe(true)
  })
})
