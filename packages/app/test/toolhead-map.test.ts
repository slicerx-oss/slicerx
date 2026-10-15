// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import type { ToolheadPlan } from '@slicerx/contracts'
import { headFilament, showToolheadChoices, toolheadNeedsForPlate, toolheadWarning } from '../src/send/toolhead-map'
import { runCall } from '../src/app-link/methods'
import { get, set } from '../src/state/store'

it('reads back each printer preference without exposing mutable app state', async () => {
  const previous = get().toolheadSkipMatching
  try {
    set({ toolheadSkipMatching: { u1: true, second: false } })
    const info = await runCall('app.info', {}) as { toolheadSkipMatching: Record<string, boolean> }
    expect(info.toolheadSkipMatching).toEqual({ u1: true, second: false })
    info.toolheadSkipMatching['u1'] = false
    expect(get().toolheadSkipMatching['u1']).toBe(true)
  } finally {
    set({ toolheadSkipMatching: previous })
  }
})

it('skips only complete matches and offers manual choices when multi-filament spool data is missing', () => {
  const plan: ToolheadPlan = { ready: true, headDataAvailable: true, toolheads: [], assignments: [{ tool: 0, physicalTool: 0, alternatives: [0, 1, 2, 3], status: 'match', reason: 'match' }] }
  expect(showToolheadChoices(plan, false)).toBe(false)
  expect(showToolheadChoices(plan, true)).toBe(false)
  const multi = { ...plan, assignments: [...plan.assignments, { ...plan.assignments[0]!, tool: 1, physicalTool: 1 }] }
  expect(showToolheadChoices(multi, false)).toBe(true)
  expect(showToolheadChoices(multi, true)).toBe(false)
  const selected = { ...multi, assignments: multi.assignments.map((a) => ({ ...a, status: 'selected' as const })) }
  expect(showToolheadChoices(selected, true)).toBe(false)
  const shared = { ...multi, assignments: multi.assignments.map((a) => ({ ...a, physicalTool: 0 })) }
  expect(showToolheadChoices(shared, false)).toBe(true)
  expect(showToolheadChoices(shared, true)).toBe(true)
  for (const warning of ['colorMismatch', 'materialMismatch', 'empty'] as const) {
    expect(showToolheadChoices({ ...plan, assignments: [{ ...plan.assignments[0]!, [warning]: true }] }, true)).toBe(true)
  }
  const unknown = { ...plan, headDataAvailable: false }
  expect(showToolheadChoices(unknown, false)).toBe(false)
  expect(showToolheadChoices({ ...unknown, assignments: [...plan.assignments, { ...plan.assignments[0]!, tool: 1 }] }, true)).toBe(true)
})

it('uses only tools extruded on this plate and preserves composite and support materials', () => {
  expect(toolheadNeedsForPlate([2, 0, 1], { filament_type: ['PLA-CF', 'PETG', 'PVA'], filament_colour: ['#000000', '#ffffff', '#eeeeee'] }, [
    { index: 1, type: 'PLA', color: '#ff0000' }, { index: 2, type: 'PETG', color: '#ffffff' },
  ])).toEqual([{ tool: 0, material: 'PLA-CF', color: '#000000' }, { tool: 2, material: 'PVA', color: '#eeeeee' }])
})

it('shows one reason for a toolhead, the empty head first, then material, then color, and keeps the rest for the tooltip', () => {
  const base = { tool: 0, physicalTool: 2, alternatives: [0, 1, 2, 3], status: 'selected' as const }
  const all = { ...base, empty: true, materialMismatch: true, colorMismatch: true, reason: 'The selected toolhead is empty; Color differs from the print filament; Material differs from PLA' }
  expect(toolheadWarning(all, true)).toEqual({ text: 'The selected toolhead is empty', more: ['Material differs from PLA', 'Color differs from the print filament'], warn: true })
  expect(toolheadWarning({ ...all, empty: false }, true)).toMatchObject({ text: 'Material differs from PLA', more: ['Color differs from the print filament'], warn: true })
  expect(toolheadWarning({ ...all, empty: false, materialMismatch: false }, true)).toEqual({ text: 'Color differs from the print filament', more: [], warn: false })
  expect(toolheadWarning({ ...base, reason: 'Material and color match' }, true)).toEqual({ text: 'Material and color match', more: [], warn: false })
  expect(toolheadWarning({ ...base, empty: true, reason: 'Spool info unavailable' }, false)).toEqual({ text: 'Spool info unavailable', more: [], warn: false })
})

it('names what a toolhead holds without a hex code', () => {
  expect(headFilament({ tool: 0, loaded: true, material: 'PLA HIGH SPEED', color: '#ff0000' }, true)).toBe('PLA HIGH SPEED Red')
  expect(headFilament({ tool: 1, loaded: true, material: null, color: null }, true)).toBe('Unknown material')
  expect(headFilament({ tool: 2, loaded: false, material: null, color: null }, true)).toBe('')
  expect(headFilament({ tool: 3, loaded: true, material: 'PLA', color: '#ff0000' }, false)).toBe('')
})
