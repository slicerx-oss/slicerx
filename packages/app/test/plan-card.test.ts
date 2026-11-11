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
import { clearPlans, planById, planChoiceId, planTool, shownPlan, type PartPlan, type PlanInput } from '../src/workspaces/mimir/plan-tool'
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

/**
 * A sizes sheet whose sizes must fit something (fits), confirmed as shown before the plan: after it the plan waits for
 * the person's Go, as these cards are about a plan that waits.
 */
const FITS_SHEET = { name: 'pilot.sheet', args: { title: 'Box sizes', views: ['iso'], fits: true, dims: [{ key: 'width', label: 'Width', value: 80, unit: 'mm', source: 'guess' }] } }

/**
 * Runs design.plan for real and shows its question the way the chat does, through the choice card hook. With `auto`
 * the plan has no fits sheet before it, so it is approved as shown at once with nobody asked.
 */
async function shown(input: PlanInput = BOX, opts: { tools?: ReturnType<typeof mimirTools>; failFirst?: boolean; auto?: boolean } = {}) {
  const steps = [...(opts.auto ? [] : [{ calls: [FITS_SHEET] }]), { calls: [{ name: 'design.plan', args: input }] }, { text: 'Done.' }]
  const p = scriptedMimir([{ id: 'plan', match: /plan/, steps }], opts.tools ?? mimirTools())
  const events: PilotEvent[] = []
  let asked!: (e: Extract<PilotEvent, { type: 'ask' }>) => void
  const ask = new Promise<Extract<PilotEvent, { type: 'ask' }>>((r) => (asked = r))
  const done = (async () => {
    for await (const e of p.run('s', 'plan a box')) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
      if (e.type === 'ask') asked(e)
    }
  })()
  const e = await ask
  let fail = opts.failFirst ?? false
  const onChoose = vi.fn((askId: string, choiceId: string) => {
    if (fail) {
      fail = false
      return Promise.reject(new Error('the run is busy'))
    }
    return p.answer!(askId, choiceId)
  })
  const card = planChoiceCard({ askId: e.askId, title: e.title, question: e.question, choices: e.choices, picked: null, actionable: true, onChoose })
  expect(card).not.toBeNull()
  render(createElement(Fragment, null, card))
  const result = async () => {
    await done
    // the plan's result, after the fits sheet's
    const call = events.find((x): x is Extract<PilotEvent, { type: 'tool_call' }> => x.type === 'tool_call' && x.tool === 'design.plan')!
    return events.find((x): x is Extract<PilotEvent, { type: 'tool_result' }> => x.type === 'tool_result' && x.callId === call.callId)!
  }
  return { e, onChoose, result }
}

const field = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement

/** A saved card's size rows as they read: the label, then the value with its unit. */
const savedRows = () => within(screen.getByTestId('mimir-plan-feature')).getAllByRole('listitem').map((r) => `${r.querySelector('.sheet-rec-label')!.textContent} ${r.querySelector('.plan-rec-v')!.textContent}`)

describe('the plan card', () => {
  it('the card shows each feature with its sizes and units', async () => {
    await shown()
    const card = screen.getByTestId('mimir-plan-card')
    expect(within(card).getByText('Plan: a box with a lid')).toBeTruthy()
    expect(within(card).getByText('Sizes in millimeters')).toBeTruthy()
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

  it('names the detail level in plain words, and the person can change it before Go', async () => {
    // a desk organizer at display detail: flat-sided, its slots arrayed
    const organizer: PlanInput = {
      ...BOX,
      part: 'desk organizer',
      detail: 'display',
      flat: ['Body'],
      proportions: 'stated: a 30 cm desk tray',
      repeats: [],
    }
    const { result } = await shown(organizer)
    const detail = screen.getByTestId('mimir-plan-detail')
    expect(within(detail).getByText('Detail')).toBeTruthy()
    expect(detail.textContent).toContain('Real proportions, curved bodies through smooth sections, repeated details patterned')
    // the levels read as words, never the plan's own values
    expect(within(detail).getByText('Display model')).toBeTruthy()
    expect(detail.textContent).not.toMatch(/\b(display|fine|basic)\b/)
    fireEvent.click(screen.getByTestId('mimir-plan-detail-basic'))
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Your changes go with Go'))
    expect(screen.getByTestId('mimir-plan-detail').textContent).toContain('Simple shapes, quick to build')
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const out = (await result()).output as { accepted: boolean; edits: PartPlan }
    expect(out.accepted).toBe(true)
    expect(out.edits.detail).toBe('basic')
    // answered, the level is a plain value
    expect(within(screen.getByTestId('mimir-plan-detail')).getByText('Basic')).toBeTruthy()
  })

  it('shows no detail row for a plan that names no level', async () => {
    await shown()
    expect(screen.queryByTestId('mimir-plan-detail')).toBeNull()
  })

  it('shows inches when the plan is in inches', async () => {
    await shown({ ...BOX, units: 'in', features: [{ name: 'Plate', sizes: { width: 3.5 } }], overall: undefined, holes: undefined } as PlanInput)
    expect(screen.getByText('Sizes in inches')).toBeTruthy()
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

  it('an inches edit goes back in inches', async () => {
    const { result } = await shown({ ...BOX, units: 'in', features: [{ name: 'Plate', sizes: { width: 3.5, thickness: 0.125 } }], overall: undefined, holes: undefined } as PlanInput)
    const t = field(/^Plate, Thickness, inches$/)
    expect(t.value).toBe('0.125')
    fireEvent.change(t, { target: { value: '0.25' } })
    fireEvent.keyDown(t, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Your changes go with Go'))
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const out = (await result()).output as { accepted: boolean; edits: PartPlan }
    expect(out.edits.units).toBe('in')
    expect(out.edits.features[0]!.sizes).toEqual({ width: 3.5, thickness: 0.25 })
  })

  for (const [what, typed] of [['a negative', '-2'], ['a zero', '0'], ['an out-of-range', '20000']] as const) {
    it(`${what} edit is turned down, and the card and the plan still agree`, async () => {
      const { result } = await shown()
      const wall = field(/^Body, Wall thickness, millimeters$/)
      fireEvent.change(wall, { target: { value: typed } })
      fireEvent.keyDown(wall, { key: 'Enter' })
      await waitFor(() => expect(wall.value).toBe('2'))
      const planId = screen.getByTestId('mimir-plan-card').dataset.planId!
      expect(planById(planId)!.features[0]!.sizes.wall_thickness).toBe(2)
      expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Waiting for your go')
      fireEvent.click(screen.getByTestId('mimir-plan-go'))
      const r = await result()
      expect(r.output).toEqual({ planId, accepted: true })
      expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Approved as shown')
    })
  }

  it('an edit the plan turns down leaves the field as it was, with a note, and Go does not claim changes', async () => {
    // a card whose plan is not in the registry: every edit is refused there
    const plan: PartPlan = { planId: 'plan_gone', ...BOX }
    const onChoose = vi.fn(async () => undefined)
    render(createElement(PlanCard, { askId: 'a', plan, picked: null, actionable: true, onChoose }))
    const wall = field(/^Body, Wall thickness, millimeters$/)
    fireEvent.change(wall, { target: { value: '3' } })
    fireEvent.keyDown(wall, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('That size was not kept. Sizes are more than 0 and up to 10000 mm.')).toBeTruthy())
    expect(wall.value).toBe('2')
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Waiting for your go')
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Approved as shown'))
  })

  it('an answer that cannot be delivered says the plan is no longer active, with no internal reason or id, and turns it off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { e, onChoose } = await shown(BOX, { failFirst: true })
    const go = screen.getByTestId('mimir-plan-go') as HTMLButtonElement
    fireEvent.click(go)
    // the status line says it, so the card keeps its height
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Nothing built. Ask mimir again.'))
    expect(screen.getByTestId('mimir-plan-status').getAttribute('role')).toBe('status')
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'the run is busy' }))
    const text = screen.getByTestId('mimir-plan-card').textContent ?? ''
    expect(text).not.toContain(e.askId)
    expect(text).not.toMatch(/the run is busy|Could not send/)
    // the buttons keep their places, only off, and the sizes are no longer fields
    expect(go.disabled).toBe(true)
    expect((screen.getByTestId('mimir-plan-change') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    fireEvent.click(go)
    expect(onChoose).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('a plan id with colons in it still gets its card', async () => {
    const { result } = await shown(BOX, { tools: [...mimirTools().filter((t) => t.name !== 'design.plan'), planTool({ newId: () => 'plan:a:b' })] })
    expect(screen.getByTestId('mimir-plan-card').dataset.planId).toBe('plan:a:b')
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    expect((await result()).output).toEqual({ planId: 'plan:a:b', accepted: true })
    expect(shownPlan('plan:a:b')).not.toBeNull()
  })

  it('Not yet answers not accepted', async () => {
    const { result } = await shown()
    fireEvent.click(screen.getByTestId('mimir-plan-change'))
    const r = await result()
    expect((r.output as { accepted: boolean }).accepted).toBe(false)
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Not approved, nothing built')
  })

  it('a plan at its default size goes ahead with nobody asked: approved, no Go, and one line on changing it after', async () => {
    // no fits sheet before it: design.plan approves it as shown at once
    const p = scriptedMimir([{ id: 'plan', match: /plan/, steps: [{ calls: [{ name: 'design.plan', args: BOX }] }, { text: 'Done.' }] }], mimirTools())
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'plan a box')) events.push(e)
    const ask = events.find((e): e is Extract<PilotEvent, { type: 'ask' }> => e.type === 'ask')!
    const answered = events.find((e): e is Extract<PilotEvent, { type: 'ask_answered' }> => e.type === 'ask_answered')!
    expect(answered).toMatchObject({ askId: ask.askId, auto: true })
    render(createElement(Fragment, null, planChoiceCard({ askId: ask.askId, title: ask.title, question: ask.question, choices: ask.choices, picked: answered.choiceId, actionable: true, onChoose: vi.fn(async () => undefined), auto: true })))
    const card = screen.getByTestId('mimir-plan-card')
    expect(card.dataset.auto).toBe('true')
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Approved as shown')
    expect(screen.queryByTestId('mimir-plan-go')).toBeNull()
    expect(screen.queryByTestId('mimir-plan-change')).toBeNull()
    expect(screen.getByTestId('mimir-plan-auto').textContent).toBe('Built at its default size; ask to resize or change it.')
    // its sizes read as text, not fields
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('a plan turned down by a written reply reads Canceled', () => {
    const plan: PartPlan = { planId: 'plan_said', ...BOX }
    render(createElement(PlanCard, { askId: 'a', plan, picked: '', actionable: true, onChoose: vi.fn(async () => undefined), dismissed: true }))
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Canceled')
    expect((screen.getByTestId('mimir-plan-go') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves an ordinary question to the choice card, and a saved card cannot be answered', () => {
    expect(planChoiceCard({ askId: 'a', title: 'Confirm', question: 'Same model?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }], picked: null, actionable: true })).toBeNull()
    const plan: PartPlan = { planId: 'plan_saved', ...BOX }
    render(createElement(PlanCard, { askId: 'a', plan, picked: null, actionable: false }))
    expect(screen.queryByTestId('mimir-plan-go')).toBeNull()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('No answer')
  })

  it('shows a row of several holes as "4 x 3.4 mm", live and saved, and keeps the count through an edit', async () => {
    const motor: PlanInput = { ...BOX, holes: [{ name: 'Motor screws', diameter: 3.4, count: 4 }, { name: 'Vent', diameter: 5 }] }
    await shown(motor)
    const card = screen.getByTestId('mimir-plan-card')
    const holes = within(card).getByRole('region', { name: 'Holes' })
    expect(within(holes).getByText('4 x')).toBeTruthy()
    // a row of one has no count
    expect(holes.textContent).not.toMatch(/1 x/)
    const screws = field(/^Holes, Motor screws, diameter, 4 holes, millimeters$/)
    expect(screws.value).toBe('3.4')
    fireEvent.change(screws, { target: { value: '3.5' } })
    fireEvent.keyDown(screws, { key: 'Enter' })
    const planId = card.dataset.planId!
    await waitFor(() => expect(planById(planId)!.holes![0]).toEqual({ name: 'Motor screws', diameter: 3.5, count: 4 }))
    cleanup()
    render(createElement(PlanCard, { askId: 'b', plan: { planId: 'plan_saved', ...motor }, picked: null, actionable: false }))
    expect(within(screen.getByRole('region', { name: 'Holes' })).getByText(/4 x\s*3\.4\s*mm/)).toBeTruthy()
  })

  it('shows a count with no unit and an angle in degrees, live and saved, beside a length in mm', async () => {
    const gear: PlanInput = { ...BOX, features: [{ name: 'Plate', kind: 'pattern', sizes: { count: 4, angle_deg: 30, width: 80 } }], overall: undefined, holes: undefined }
    // the angle reads in degrees, so its label drops the deg its key ends in
    render(createElement(PlanCard, { askId: 'b', plan: { planId: 'plan_saved', ...gear }, picked: null, actionable: false }))
    const rows = savedRows()
    expect(rows).toEqual(['Count 4', 'Angle 30°', 'Width 80 mm'])
    cleanup()
    await shown(gear)
    const feature = screen.getByTestId('mimir-plan-feature')
    expect(field(/^Plate, Count$/).value).toBe('4')
    expect(field(/^Plate, Angle, degrees$/).value).toBe('30')
    expect(field(/^Plate, Width, millimeters$/).value).toBe('80')
    // one mm, for the width
    expect(within(feature).getAllByText('mm')).toHaveLength(1)
    expect(within(feature).getAllByText('°')).toHaveLength(1)
  })

  it('rounds a fraction typed into a count to a whole number, so the field, the plan and Go agree', async () => {
    const { result } = await shown({ ...BOX, features: [{ name: 'Gear', sizes: { teeth: 18, width: 40 } }], overall: undefined, holes: undefined })
    const teeth = field(/^Gear, Teeth$/)
    fireEvent.change(teeth, { target: { value: '20.4' } })
    fireEvent.keyDown(teeth, { key: 'Enter' })
    const planId = screen.getByTestId('mimir-plan-card').dataset.planId!
    await waitFor(() => expect(planById(planId)!.features[0]!.sizes['teeth']).toBe(20))
    expect(field(/^Gear, Teeth$/).value).toBe('20')
    // a count under one is turned down by the field, so the plan keeps the last whole count
    fireEvent.change(field(/^Gear, Teeth$/), { target: { value: '0.4' } })
    fireEvent.keyDown(field(/^Gear, Teeth$/), { key: 'Enter' })
    expect(planById(planId)!.features[0]!.sizes['teeth']).toBe(20)
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const out = (await result()).output as { edits: PartPlan }
    expect(out.edits.features[0]!.sizes).toEqual({ teeth: 20, width: 40 })
  })

  it('shows a fractional count that came in the plan with its own decimals, live, saved and on Go', async () => {
    const coil: PlanInput = { ...BOX, features: [{ name: 'Spring', sizes: { segments: 7.5, width: 12 } }], overall: undefined, holes: undefined }
    render(createElement(PlanCard, { askId: 'b', plan: { planId: 'plan_saved', ...coil }, picked: null, actionable: false }))
    expect(savedRows()).toEqual(['Segments 7.5', 'Width 12 mm'])
    cleanup()
    const { result } = await shown(coil)
    expect(field(/^Spring, Segments$/).value).toBe('7.5')
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const out = (await result()).output as { accepted: boolean; edits?: PartPlan }
    expect(out).toMatchObject({ accepted: true })
    expect(out.edits).toBeUndefined()
  })

  it('shows a planned count with up to four decimals of its own, so the field matches what Go sends', async () => {
    const coil: PlanInput = { ...BOX, features: [{ name: 'Spring', sizes: { segments: 7.555, steps: 2.12345 } }], overall: undefined, holes: undefined }
    await shown(coil)
    expect(field(/^Spring, Segments$/).value).toBe('7.555')
    expect(field(/^Spring, Steps$/).value).toBe('2.1235')
  })

  it('reads each size by the kind the plan gives it, over its key, and Go sends the kind-aware values', async () => {
    // width is a length by its key and teeth a count; the plan says otherwise, so the plan wins
    const odd: PlanInput = { ...BOX, features: [{ name: 'Gear', sizes: { width: 4, teeth: 20, pitch: 30 }, kinds: { width: 'count', teeth: 'length', pitch: 'angle' } }], overall: undefined, holes: undefined }
    render(createElement(PlanCard, { askId: 'b', plan: { planId: 'plan_saved', ...odd }, picked: null, actionable: false }))
    expect(savedRows()).toEqual(['Width 4', 'Teeth 20 mm', 'Pitch 30°'])
    cleanup()
    const { result } = await shown(odd)
    expect(field(/^Gear, Width$/).value).toBe('4')
    expect(field(/^Gear, Teeth, millimeters$/).value).toBe('20')
    expect(field(/^Gear, Pitch, degrees$/).value).toBe('30')
    const width = field(/^Gear, Width$/)
    fireEvent.change(width, { target: { value: '5.4' } })
    fireEvent.keyDown(width, { key: 'Enter' })
    const teeth = field(/^Gear, Teeth, millimeters$/)
    fireEvent.change(teeth, { target: { value: '20.5' } })
    fireEvent.keyDown(teeth, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Your changes go with Go'))
    fireEvent.click(screen.getByTestId('mimir-plan-go'))
    const out = (await result()).output as { edits: PartPlan }
    expect(out.edits.features[0]).toEqual({ name: 'Gear', sizes: { width: 5, teeth: 20.5, pitch: 30 }, kinds: { width: 'count', teeth: 'length', pitch: 'angle' } })
  })

  it('never converts a count or an angle in an inch plan', async () => {
    const gear: PlanInput = { ...BOX, units: 'in', features: [{ name: 'Gear', sizes: { teeth: 20, draft: 1.5, thickness: 0.25 } }], overall: undefined, holes: undefined }
    render(createElement(PlanCard, { askId: 'b', plan: { planId: 'plan_saved', ...gear }, picked: null, actionable: false }))
    const rows = savedRows()
    expect(rows).toEqual(['Teeth 20', 'Draft 1.5°', 'Thickness 0.25 in'])
    cleanup()
    await shown(gear)
    expect(field(/^Gear, Teeth$/).value).toBe('20')
    expect(field(/^Gear, Draft, degrees$/).value).toBe('1.5')
    expect(field(/^Gear, Thickness, inches$/).value).toBe('0.25')
  })

  it('puts keys in plain words', () => {
    expect(plainLabel('wall_thickness')).toBe('Wall thickness')
    expect(plainLabel('lipHeight')).toBe('Lip height')
    expect(plainLabel('m3-hole')).toBe('M3 hole')
  })
})

describe('a plan change card', () => {
  const was: PartPlan = { planId: 'plan_1', ...BOX, assumptions: [...BOX.assumptions] }
  const asked: PartPlan = { ...was, planId: 'plan_1~r2', features: was.features.map((f) => (f.name === 'Body' ? { ...f, sizes: { ...f.sizes, wall_thickness: 2.4 } } : f)), overall: { ...was.overall!, z: 48 } }
  const why = 'The lid adds 4 mm over the rim, so the box closes at 48 mm.'

  it('says the build asks to change the plan, with its reason and the approved value beside each changed size', () => {
    render(createElement(PlanCard, { askId: 'a', plan: asked, picked: null, actionable: true, onChoose: vi.fn(async () => undefined), amend: { was, why } }))
    const card = screen.getByTestId('mimir-plan-card')
    expect(card.getAttribute('aria-label')).toBe('Plan change for a box with a lid')
    expect(card.getAttribute('data-amends')).toBe('plan_1')
    expect(within(card).getByText('Plan change: a box with a lid')).toBeTruthy()
    expect(within(card).getByText('mimir asks to change the approved plan')).toBeTruthy()
    expect(screen.getByTestId('mimir-plan-why').textContent).toBe(why)
    // only the changed sizes carry the approved value, in the plan's units
    expect(screen.getAllByTestId('mimir-plan-was').map((t) => t.textContent)).toEqual(['was 2 mm', 'was 44 mm'])
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Waiting for your go on the change')
  })

  it('reads Plan changed on Go and keeps the old plan on Not yet', () => {
    render(createElement(PlanCard, { askId: 'a', plan: asked, picked: planChoiceId('go', 'plan_1~r2'), actionable: false, amend: { was, why } }))
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Plan changed')
    cleanup()
    render(createElement(PlanCard, { askId: 'a', plan: asked, picked: planChoiceId('change', 'plan_1~r2'), actionable: false, amend: { was, why } }))
    expect(screen.getByTestId('mimir-plan-status').textContent).toBe('Not changed, the plan stays as approved')
  })
})
