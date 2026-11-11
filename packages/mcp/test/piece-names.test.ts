// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A print-in-place plan names its pieces after the features that build them ("Base shell" and "Lid shell") while the
// build names the parts otherwise ("Base" and "Lid"). A new part that builds a piece the design's plan names takes the
// plan's name for it, so design.check finds both pieces. The replayed calls are a hinged box built in the mimir tab
// (fixtures/hinged-box-piece-names.json): its plan, its sheet, the build and its first check, which failed on the piece
// names (and on the gaps) before; its fix round never renamed a part, and its second check failed on the names again.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Design } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS, type CreativePrompt } from '../evals/creative/prompts'
import { runPrompt } from '../evals/creative/run'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { pieceNameFor } from '../src/design-tools'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('piece-names')

// the box as the mimir tab was asked for it, on a P1S with PLA and a 0.4 mm nozzle
const P: CreativePrompt = {
  id: 'hinged-box',
  title: 'Hinged box',
  prompt: 'A small box with a hinged lid, 80 by 50 by 35 mm, 2 mm walls, with a pin hinge along the back edge.',
  machine: CREATIVE_PROMPTS.find((x) => x.id === 'gear-pair')!.machine,
  bodies: [1, 4],
  mechanism: true,
}
const recorded = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hinged-box-piece-names.json'), 'utf8')) as { steps: NonNullable<Parameters<typeof runPrompt>[1]['steps']> }

interface Seen {
  ok?: boolean
  summary?: string
  result?: { parts?: { name: string }[]; items?: { name: string; got: string; pass: boolean }[]; bodies?: { name: string }[] }
}

describe('a part that builds a print-in-place piece takes the plan name', () => {
  it('the recorded hinged box: its check finds Base shell and Lid shell', async () => {
    // the reply after the check asks the person how to go on, and the person is not answered here
    const run = await runPrompt(P, { geom: { run: (op, input) => g.engine(op, input) }, steps: recorded.steps, answerRecorded: true, defaultAnswer: false, tabTools: true })
    expect(run.error).toBeUndefined()
    const seen = run.steps.flatMap((s) => s.seen ?? []).map((t) => JSON.parse(t) as Seen)
    // the base and the lid were asked for as Base and Lid, each tagged with its piece's feature
    const builds = seen.filter((s) => /^Built: step \d+, Add /.test(s.summary ?? ''))
    expect(builds[0]!.summary).toMatch(/^Built: step 1, Add Base shell\. The new part is named Base shell, as the plan names that print-in-place piece, in place of Base$/)
    expect(builds[1]!.summary).toMatch(/^Built: step 3, Add Lid shell\. The new part is named Lid shell, as the plan names that print-in-place piece, in place of Lid$/)
    // parts that build no piece keep the names given
    expect(builds.slice(2).map((s) => s.result!.parts!.at(-1)!.name)).toEqual(['Hinge knuckles', 'Hinge pin'])
    // the fit check reads the bodies by the plan's names
    const fit = seen.find((s) => s.result?.bodies)!
    expect(fit.result!.bodies!.map((b) => b.name)).toEqual(['Base shell', 'Lid shell', 'Hinge knuckles 1', 'Hinge knuckles 2', 'Hinge pin'])
    const checks = seen.filter((s) => s.result?.items)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.result!.items!.find((x) => x.name === 'pieces')).toMatchObject({ pass: true })
    // it still fails on what the build got wrong: the hinge pieces touch
    expect(checks[0]!.result!.items!.filter((x) => !x.pass).map((x) => x.name)).toEqual(['gaps'])
  })
})

describe('pieceNameFor', () => {
  const plan = (printInPlace: PartPlan['printInPlace']): PartPlan => ({
    planId: 'p1',
    part: 'Hinged box',
    units: 'mm',
    features: [
      { name: 'Base shell', kind: 'extrude', sizes: { height: 25 } },
      { name: 'Lid shell', kind: 'extrude', sizes: { height: 10 } },
    ],
    assumptions: [],
    questions: [],
    ...(printInPlace !== undefined ? { printInPlace } : {}),
  })
  const design = (...names: string[]): Design => ({ id: 'd1', parts: names.map((name) => ({ name })) }) as unknown as Design
  const tied = (p: PartPlan) => {
    const plans = createPlanRegistry()
    plans.put(p, 'd1')
    return plans
  }

  it('names the part after the piece its feature builds, in the plan spelling', () => {
    expect(pieceNameFor(tied(plan(['Base shell', 'Lid shell'])), design(), 'base shell', 'Base')).toBe('Base shell')
    expect(pieceNameFor(tied(plan(['Base shell', 'Lid shell'])), design('Base shell'), 'Lid shell', undefined)).toBe('Lid shell')
  })

  it('keeps the name given otherwise', () => {
    const plans = tied(plan(['Base shell', 'Lid shell']))
    // no feature, or one that is no piece
    expect(pieceNameFor(plans, design(), undefined, 'Base')).toBeUndefined()
    expect(pieceNameFor(plans, design(), 'Hinge knuckles', 'Base knuckle')).toBeUndefined()
    // a name that is a piece already, and a piece name another part has
    expect(pieceNameFor(plans, design(), 'Base shell', 'Lid shell')).toBeUndefined()
    expect(pieceNameFor(plans, design('Base shell'), 'Base shell', 'Base knuckle')).toBeUndefined()
    // a plan that does not print in place, or one tied to another design
    expect(pieceNameFor(tied(plan(false)), design(), 'Base shell', 'Base')).toBeUndefined()
    const other = createPlanRegistry()
    other.put(plan(['Base shell', 'Lid shell']), 'd2')
    expect(pieceNameFor(other, design(), 'Base shell', 'Base')).toBeUndefined()
    // a plan whose sizes changed after it was approved
    plans.stale('p1')
    expect(pieceNameFor(plans, design(), 'Base shell', 'Base')).toBeUndefined()
  })
})
