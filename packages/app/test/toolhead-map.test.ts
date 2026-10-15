// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import type { ToolheadPlan } from '@slicerx/contracts'
import { showToolheadChoices, toolheadNeedsForPlate } from '../src/send/toolhead-map'
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
  expect(showToolheadChoices(plan, false)).toBe(true)
  expect(showToolheadChoices(plan, true)).toBe(false)
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
