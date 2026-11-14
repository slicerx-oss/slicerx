// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stands-on failure names the height of the top the part was measured against, so a fix round can build from it
// without reading the support itself. A ship run's closing check failed two decks on a hull whose deck curves up toward
// both ends, and a mast on one of them, with no height to build from; the fix round had nothing to go on. The plan and
// steps are that run's own, read as design.check reads them (featureHeights, then stackItem), with no engine.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Design as HostDesign, Step } from '@slicerx/cad-history'
import { featureHeights } from '../src/body-facts'
import { stackItem } from '../src/plan-detail'

const run = JSON.parse(readFileSync(new URL('./fixtures/stands-on-curved-deck.json', import.meta.url), 'utf8')) as {
  plan: Parameters<typeof stackItem>[0]
  steps: Step[]
}
const heights = featureHeights({ history: { base: [], steps: run.steps }, status: run.steps.map(() => ({ state: 'ok' })) } as unknown as HostDesign, run.steps)

describe('stands on, with the height to build from', () => {
  it('names the lowest of a curved deck under each part, and a flat support\'s top, as the heights the parts were measured against', () => {
    expect(stackItem(run.plan, heights)).toMatchObject({
      name: 'stands on',
      pass: false,
      got:
        'Forecastle deck stands on Hull (loft), but its base is 0.34 mm above its top, so it floats; build it from the top of Hull (loft), whose lowest point under it is at z 15.26 mm; ' +
        'Poop deck stands on Hull (loft), but its base is 0.29 mm above its top, so it floats; build it from the top of Hull (loft), whose lowest point under it is at z 15.31 mm; ' +
        'Mainmast stands on Poop deck, but its base is 0.7 mm below its top, so 11.3 mm of it shows of a planned 12 mm; build it from the top of Poop deck, whose highest point is at z 17.6 mm',
    })
  })

  it('passes each deck once its base is moved to the named height less 0.05 mm, and each mast once it starts on its deck', () => {
    const at = (name: string, lo: number) => ({ ...heights[name]!, lo, hi: heights[name]!.hi - heights[name]!.lo + lo })
    const decks = { 'forecastle deck': at('forecastle deck', 15.26 - 0.05), 'poop deck': at('poop deck', 15.31 - 0.05) }
    const moved = { ...heights, ...decks, mainmast: at('mainmast', decks['poop deck'].hi - 0.05), foremast: at('foremast', decks['forecastle deck'].hi - 0.05) }
    expect(stackItem(run.plan, moved)).toMatchObject({ pass: true })
  })
})
