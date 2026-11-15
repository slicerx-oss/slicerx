// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The unheld rule and the not-asked rule agree. A display plan whose levels and repeated parts have no real size is
// refused with the sizes it must give, and told to write "real: <feature> <size> not given by the source" for one the
// source does not give. The part's next plan that writes those very lines is taken, though no lookup listed the sizes
// as missing: the refusal asked for them. Replayed from a recorded chain of plans, its part and features renamed, its
// shape, sizes, lookups and assumption lines as recorded; before, the second plan was refused as not asked for in any
// lookup, and the chain took four more refusals and two more lookups.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
const SOURCES = [{ title: 'Canal lock facts', url: 'https://example.org/canal-lock' }]

/** The three lookups the recorded chat ran before its first plan, in order (lookup_1 to lookup_3). */
const LOOKUPS = [
  {
    subject: 'Canal lock',
    asked: ['Overall length', 'Beam (width)', 'Height base to top of chimneys', 'Chimney height above top terrace', 'Basin depth base to top terrace'],
    found: [
      { size: 'Beam (width)', mm: 28200, said: '28.2 m' },
      { size: 'Height base to top of chimneys', mm: 53300, said: '53.3 m' },
      { size: 'Chimney height above top terrace', mm: 24841.2, said: '81.5 feet' },
      { size: 'Basin depth base to top terrace', mm: 18440.4, said: '60.5 feet' },
    ],
    missing: ['Overall length'],
  },
  { subject: 'Canal lock length overall', asked: ['Length overall', 'Length between ends'], found: [{ size: 'Length between ends', mm: 259100, said: '259.1 m' }], missing: ['Length overall'] },
  {
    subject: 'Canal lock',
    asked: ['Front pole height above base', 'Chimney width (long axis)', 'Distance between chimneys', 'Lamp length'],
    found: [{ size: 'Chimney width (long axis)', mm: 7000, said: '7 m' }],
    missing: ['Front pole height above base', 'Distance between chimneys', 'Lamp length'],
  },
]

const FEATURES: PlanInput['features'] = [
  { name: 'Basin', kind: 'loft', sizes: { sections: 8, length: 215, beam: 22.6, depth: 14.75 }, kinds: { sections: 'count' } },
  { name: 'Lower terrace', kind: 'extrude', on: 'Basin', sizes: { length: 140, width: 21, height: 4 } },
  { name: 'Middle terrace', kind: 'extrude', on: 'Lower terrace', sizes: { length: 117, width: 20, height: 4.05 } },
  { name: 'Top terrace houses', kind: 'extrude', on: 'Middle terrace', sizes: { length: 93, width: 12, height: 3 } },
  { name: 'Chimney', kind: 'extrude', on: 'Middle terrace', sizes: { width: 5.6, depth: 4.4, height: 19.9, rake: 6 }, kinds: { rake: 'angle' } },
  { name: 'Chimney array', kind: 'array', sizes: { count: 4, spacing: 17 }, kinds: { count: 'count' } },
  { name: 'Front pole', kind: 'extrude', on: 'Basin', sizes: { diameter: 1.6, height: 32 } },
  { name: 'Rear pole', kind: 'extrude', on: 'Basin', sizes: { diameter: 1.6, height: 31 } },
  { name: 'Lamp', kind: 'extrude', on: 'Middle terrace', sizes: { length: 7, width: 1.8, height: 1.2 } },
  { name: 'Lamp array', kind: 'array', sizes: { count: 16, spacing: 13.5 }, kinds: { count: 'count' } },
]

/** The first plan as recorded: every level a flat body of its own, no real size for the levels or the repeats. */
const FIRST: PlanInput = {
  part: 'Canal lock',
  units: 'mm',
  detail: 'display',
  scale: '1250',
  proportions: 'lookup: 259.1 m between ends, 28.2 m beam, 18.4 m base to top terrace, chimneys 24.8 m above top terrace, scaled 1:1250',
  curved: ['Basin'],
  flat: ['Lower terrace', 'Middle terrace', 'Top terrace houses'],
  tiers: { 'Lower terrace': ['Lower terrace', 'Middle terrace', 'Top terrace houses'] },
  repeats: ['Chimneys', 'Lamps'],
  features: FEATURES,
  overall: { x: 215, y: 22.6, z: 47.6 },
  real: [
    { feature: 'Basin', size: 'length', mm: 259100, lookup: 'lookup_2' },
    { feature: 'Basin', size: 'beam', mm: 28200, lookup: 'lookup_1' },
    { feature: 'Basin', size: 'depth', mm: 18440.4, lookup: 'lookup_1' },
    { feature: 'Chimney', size: 'height', mm: 24841.2, lookup: 'lookup_1' },
    { feature: 'Chimney', size: 'width', mm: 7000, lookup: 'lookup_3' },
  ],
  printInPlace: false,
  assumptions: [
    'Full basin down to its base, flat bottom on the bed, front at +x',
    'Sized to about 85% of a 256 mm bed since no printer is chosen',
    'Poles and lamps are thicker than scale so they print; pole heights and chimney spacing are estimates',
    'Railings and small fittings are too small at 1:1250 and are left out',
    'One filament, no paint',
  ],
  questions: [],
}

/** The second plan as recorded: one flat body with its levels, and a "not given" line for each size the refusal named. */
const SECOND: PlanInput = {
  ...FIRST,
  flat: ['Lower terrace'],
  assumptions: [
    'Full basin down to its base, flat bottom on the bed, front at +x',
    'Sized to about 85% of a 256 mm bed since no printer is chosen',
    'real: Lower terrace length not given by the source',
    'real: Middle terrace length not given by the source',
    'real: Top terrace houses length not given by the source',
    'real: Chimney array spacing not given by the source',
    'real: Lamp height not given by the source',
    'real: Lamp array spacing not given by the source',
    'Poles and lamps are thicker than scale so they print; pole heights are estimates',
    'Railings and small fittings are too small at 1:1250 and are left out',
    'One filament, no paint',
  ],
}

/** The unheld sentence of the first refusal, as recorded with the names changed. */
const UNHELD =
  'real: a level\'s length and a repeated part\'s height and spacing are held to scale too, so give the real Lower terrace length, Middle terrace length, Top terrace houses length, Chimney array spacing, Lamp height and Lamp array spacing, each tied to its size; for a size the source does not give, say so in assumptions as "real: Lamp array spacing not given by the source"'
/** The not-asked refusal the second plan got before. */
const NOT_ASKED =
  'real: Lower terrace length, Middle terrace length, Top terrace houses length, Chimney array spacing, Lamp height and Lamp array spacing were not asked for in any lookup, so the source has not been read for them; ask design.lookup_sizes for them first'

/** The tab's design.plan in one chat with web lookups, the recorded lookups already run, every card answered Go. */
function tab() {
  const card = createCardPlans(createPlanRegistry())
  for (const l of LOOKUPS) card.lookups.add({ ...l, session: 's1', sources: SOURCES, searched: true })
  const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const plan = tools.find((t) => t.name === 'design.plan')!
  const web = async () => ({ text: '', citations: [] })
  const ctx = (sessionId: string) =>
    ({ sessionId, web, context: { project: 'creative', machine, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }) }) as unknown as ToolContext
  return { card, plan: (input: unknown, session = 's1') => plan.run(plan.input.parse(input) as never, ctx(session)) }
}

describe('a size an unheld refusal named stands as not given in the part\'s next plan', () => {
  it('replays the recorded chain: the first plan is refused for its unheld sizes, the second, naming them as asked, is taken', async () => {
    const t = tab()
    await expect(t.plan(FIRST)).rejects.toThrow(UNHELD)
    const out = await t.plan(SECOND)
    expect(out.ok).not.toBe(false)
    expect(out.output).toMatchObject({ planId: 'plan_1', accepted: true })
  })

  it('still refuses those lines with no refusal before them, and in another chat or for another part', async () => {
    // no refusal named the sizes: the not-asked rule holds them to a lookup as before
    await expect(tab().plan(SECOND)).rejects.toThrow(NOT_ASKED)
    // the refusal was in another chat
    const t = tab()
    await expect(t.plan(FIRST)).rejects.toThrow(UNHELD)
    await expect(t.plan(SECOND, 's2')).rejects.toThrow(/were not asked for in any lookup/)
    // the refusal was for another part
    await expect(t.plan({ ...SECOND, part: 'Stone tower' })).rejects.toThrow(NOT_ASKED)
  })

  it('takes only the sizes the refusal named: a line for any other size is still refused as not asked', async () => {
    const t = tab()
    await expect(t.plan(FIRST)).rejects.toThrow(UNHELD)
    // the lines for the sizes the refusal named stand, while lines for a repeat the first plan did not have are refused
    const third: PlanInput = {
      ...SECOND,
      features: [...FEATURES, { name: 'Bollard', kind: 'extrude', on: 'Basin', sizes: { diameter: 1, height: 2 } }, { name: 'Bollard array', kind: 'array', sizes: { count: 6, spacing: 20 }, kinds: { count: 'count' } }],
      repeats: ['Chimneys', 'Lamps', 'Bollards'],
      assumptions: [...SECOND.assumptions.slice(0, 9), 'real: Bollard height not given by the source', 'real: Bollard array spacing not given by the source'],
    }
    await expect(t.plan(third)).rejects.toThrow('real: Bollard height and Bollard array spacing were not asked for in any lookup')
  })

  it('forgets the named sizes once a plan of the part is shown', async () => {
    const t = tab()
    await expect(t.plan(FIRST)).rejects.toThrow(UNHELD)
    await t.plan(SECOND)
    await expect(t.plan(SECOND)).rejects.toThrow(NOT_ASKED)
  })
})
