// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

import { describe, expect, it } from 'vitest'
import { formatValue, SETTINGS, settingDef } from '../src/adapters/settings'
import { offeredValues } from '../src/workspaces/prepare/expert-settings'

describe('enum pickers', () => {
  const def = { enumValues: ['a', 'b', 'c'], enumLabels: ['A', 'B', 'C'], unavailableValues: ['b'] }
  it('leaves out values the engine cannot print', () => {
    expect(offeredValues(def, 'a').map((o) => o.value)).toEqual(['a', 'c'])
  })
  it('keeps one a project already uses, flagged', () => {
    expect(offeredValues(def, 'b')).toContainEqual({ value: 'b', label: 'B', gone: true })
  })
})

describe('enum option labels', () => {
  // Names of SlicerX features stay lowercase, as everywhere else in the app.
  const NAMES = new Set(['aegis'])

  it('gives every option of every enum setting a readable label, never its raw value', () => {
    const raw: string[] = []
    for (const d of SETTINGS) {
      if (d.type !== 'enum' && d.type !== 'enums') continue
      expect(d.enumLabels?.length, d.key).toBe(d.enumValues?.length)
      for (const o of offeredValues(d, undefined)) {
        // A label may equal its value only when the value already reads as a word people use (PNG, Bowden).
        if (o.label === o.value && !NAMES.has(o.value) && !/^[A-Z0-9][A-Za-z0-9 ]*$/.test(o.value)) raw.push(`${d.key}: ${o.value}`)
        if (/_|^[a-z]/.test(o.label) && !NAMES.has(o.label) && !o.label.startsWith('sleipnir')) raw.push(`${d.key}: ${o.label}`)
      }
    }
    expect(raw).toEqual([])
  })

  it('writes a chosen value by its label wherever the app shows a value', () => {
    expect(formatValue(settingDef('wall_generator'), 'arachne')).toBe('Arachne')
    expect(formatValue(settingDef('z_hop_types'), ['Normal Lift'])).toBe('Normal')
    expect(formatValue(settingDef('layer_height'), 0.2)).toBe(formatValue(undefined, 0.2) + ' mm')
  })

  it('shows fuzzy skin as Orca names it', () => {
    expect(offeredValues(settingDef('fuzzy_skin')!, undefined).map((o) => o.label)).toEqual(['Painted only', 'Contour', 'Hole', 'Contour and hole', 'All walls', 'Disabled'])
  })
})
