// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plan card in the mimir chat: each feature with its sizes and units in plain words, sizes edited inline, and Go
// that answers the plan's question with the edits. It takes the place of the choice card only for a plan this window
// made. Once answered its buttons stay where they were.
import type { PilotEvent } from '@slicerx/contracts'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanCard, planChoiceCard, plainLabel } from '../src/workspaces/mimir/plan-card'
import { clearPlans, planById, planChoiceId, type PartPlan, type PlanInput } from '../src/workspaces/mimir/plan-tool'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'

afterEach(() => {
  cleanup()
  clearPlans()
})

const BOX: PlanInput = {
  part: 'a box with a lid',
  units: 'mm',
  features: [
    { name: 'Body', kind: 'extrude', sizes: { width: 80, wall_thickness: 2 } },
    { name: 'Lid lip', sizes: { lipHeight: 4 } },
  ],
  overall: { x: 80, y: 60, z: 44 },
  holes: [{ name: 'Vent', diameter: 5 }],
  assumptions: ['PLA, so a 0.2 mm clearance on the lip'],
  questions: ['Does the lid need a finger notch?'],
}

/** Runs design.plan for real and shows its question the way the chat does, through the choice card hook. */
async function shown(input: PlanInput = BOX) {
  const p = scriptedMimir([{ id: 'plan', match: /plan/, steps: [{ calls: [{ name: 'design.plan', args: input }] }, { text: 'Done.' }] }], mimirTools())
  const events: PilotEvent[] = []
  let asked!: (e: Extract<PilotEvent, { type: 'ask' }>) => void
  const ask = new Promise<Extract<PilotEvent, { type: 'ask' }>>((r) => (asked = r))
  const done = (async () => {
    for await (const e of p.run('s', 'plan a box')) {
      events.push(e)
      if (e.type === 'ask') asked(e)
    }
  })()
  const e = await ask
  const onChoose = vi.fn((askId: string, choiceId: string) => p.answer!(askId, choiceId))
  const card = planChoiceCard({ askId: e.askId, title: e.title, question: e.question, choices: e.choices, picked: null, actionable: true, onChoose })
  expect(card).not.toBeNull()
  render(createElement(Fragment, null, card))
  const result = async () => {
    await done
    return events.find((x): x is Extract<PilotEvent, { type: 'tool_result' }> => x.type === 'tool_result')!
  }
  return { e, onChoose, result }
}

const field = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement

describe('the plan card', () => {
  it('the card shows each feature with its sizes and units', async () => {
    await shown()
    const card = screen.getByTestId('mimir-plan-card')
    expect(within(card).getByText('Plan: a box with a lid')).toBeTruthy()
    expect(within(card).getByText('Sizes in mm')).toBeTruthy()
    const features = screen.getAllByTestId('mimir-plan-feature')
    expect(features.map((f) => within(f).getAllByText(/^(Body|Lid lip)$/)[0]!.textContent)).toEqual(['Body', 'Lid lip'])
    // plain labels, never the keys mimir sent
    expect(within(features[0]!).getByText('Width')).toBeTruthy()
    expect(within(features[0]!).getByText('Wall thickness')).toBeTruthy()
    expect(within(features[1]!).getByText('Lip height')).toBeTruthy()
    expect(card.textContent).not.toMatch(/wall_thickness|lipHeight/)
    expect(field(/^Body, Width, millimeters$/).value).toBe('80')
    expect(field(/^Body, Wall thickness, millimeters$/).value).toBe('2')
    expect(within(features[0]!).getAllByText('mm')).toHaveLength(2)
    // the overall size, the holes, what it assumed and what is still open
    expect(field(/^Overall, Height, millimeters$/).value).toBe('44')
    expect(field(/^Overall, Width, millimeters$/).value).toBe('80')
    expect(field(/^Holes, Vent, diameter, millimeters$/).value).toBe('5')
    expect(card.textContent).toContain('PLA, so a 0.2 mm clearance on the lip')
    expect(card.textContent).toContain('Does the lid need a finger notch?')
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Waiting for your go')
  })

  it('shows inches when the plan is in inches', async () => {
    await shown({ ...BOX, units: 'in', features: [{ name: 'Plate', sizes: { width: 3.5 } }], overall: undefined, holes: undefined } as PlanInput)
    expect(screen.getByText('Sizes in in')).toBeTruthy()
    expect(field(/^Plate, Width, inches$/).value).toBe('3.5')
  })

  it('editing a size returns the edited plan', async () => {
    const { result, e } = await shown()
    const wall = field(/^Body, Wall thickness, millimeters$/)
    fireEvent.change(wall, { target: { value: '2.4' } })
    fireEvent.keyDown(wall, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Your changes go with Go'))
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const r = await result()
    const out = r.output as { planId: string; accepted: boolean; edits: PartPlan }
    expect(out.accepted).toBe(true)
    expect(out.edits.features[0]!.sizes.wall_thickness).toBe(2.4)
    expect(out.edits.features[0]!.sizes.width).toBe(80)
    expect(planById(out.planId)!.features[0]!.sizes.wall_thickness).toBe(2.4)
    expect(e.choices[0]!.id).toBe(planChoiceId('go', out.planId))
  })

  it('Go returns accepted true, and the buttons stay in place, only disabled', async () => {
    const { result, onChoose, e } = await shown()
    const go = screen.getByTestId('mimir-plan-go') as HTMLButtonElement
    const notYet = screen.getByTestId('mimir-plan-change') as HTMLButtonElement
    fireEvent.click(go)
    const r = await result()
    expect(r.output).toEqual({ planId: (r.output as { planId: string }).planId, accepted: true })
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenCalledWith(e.askId, e.choices[0]!.id)
    // the same two buttons, now disabled; the fields are read-only values
    expect(screen.getByTestId('mimir-plan-go')).toBe(go)
    expect(screen.getByTestId('mimir-plan-change')).toBe(notYet)
    expect(go.disabled && notYet.disabled).toBe(true)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Approved as shown')
    fireEvent.click(go)
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('Not yet answers not accepted', async () => {
    const { result } = await shown()
    fireEvent.click(screen.getByTestId('mimir-plan-change'))
    const r = await result()
    expect((r.output as { accepted: boolean }).accepted).toBe(false)
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Not approved, nothing built')
  })

  it('leaves an ordinary question to the choice card, and a saved card cannot be answered', () => {
    expect(planChoiceCard({ askId: 'a', title: 'Confirm', question: 'Same model?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }], picked: null, actionable: true })).toBeNull()
    const plan: PartPlan = { planId: 'plan_saved', ...BOX }
    render(createElement(PlanCard, { askId: 'a', plan, picked: null, actionable: false }))
    expect(screen.queryByTestId('mimir-plan-go')).toBeNull()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('No answer')
  })

  it('puts keys in plain words', () => {
    expect(plainLabel('wall_thickness')).toBe('Wall thickness')
    expect(plainLabel('lipHeight')).toBe('Lip height')
    expect(plainLabel('m3-hole')).toBe('M3 hole')
  })
})
