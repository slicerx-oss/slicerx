// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { unavailableIn } from '@slicerx/settings'
import { formatValue, SETTINGS, settingDef } from '../src/adapters/settings'
import { Field, offeredValues, unsupportedNote } from '../src/workspaces/prepare/expert-settings'

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

describe('a value the engine cannot print', () => {
  let root: Root | null = null
  let el: HTMLElement | null = null
  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    el?.remove()
    root = null
  })
  /** The prime tower wall row holding `value`, re-rendered with `next` when given (a pick in the menu). */
  function wallRow(value: string, next?: string, unavailable?: readonly string[]): HTMLLIElement {
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    const def = settingDef('wipe_tower_wall_type')!
    const extra = unavailable ? { unavailable } : {}
    flushSync(() => root!.render(createElement(Field, { def, value, overridden: true, onSet: () => {}, ...extra })))
    if (next !== undefined) flushSync(() => root!.render(createElement(Field, { def, value: next, overridden: true, onSet: () => {}, ...extra })))
    return el.querySelector('li')!
  }

  it('names the fallback from the setting default, not a fixed word', () => {
    const def = { default: 'b', enumValues: ['a', 'b', 'c'], enumLabels: ['Ay', 'Bee', 'Cee'], unavailableValues: ['c'] }
    expect(unsupportedNote(def, 'c')).toBe('Cee is unsupported; slicing uses Bee.')
    expect(unsupportedNote(def, 'a')).toBeUndefined()
    expect(unsupportedNote({ ...def, default: 'c' }, 'c')).toBe('Cee is unsupported; slicing uses the default.')
  })

  it('shows a cone prime tower wall as unsupported under the select, tied to it, and nothing for rib', () => {
    const li = wallRow('cone')
    const note = li.querySelector('[data-testid="slice-setting-unsupported"]')!
    expect(note.textContent).toBe('Cone is unsupported; slicing uses Rectangle.')
    expect(li.querySelector('select')!.getAttribute('aria-describedby')).toBe(note.id)
    expect([...li.querySelectorAll('option')].map((o) => o.textContent)).toContain('Cone (unsupported)')
    root && flushSync(() => root!.unmount())
    el?.remove()
    root = null
    const rib = wallRow('rib')
    expect(rib.querySelector('[data-testid="slice-setting-unsupported"]')).toBeNull()
    expect(rib.querySelector('select')!.hasAttribute('aria-describedby')).toBe(false)
    expect([...rib.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Rectangle', 'Rib'])
  })

  it('clears the line when a supported value is picked', () => {
    const li = wallRow('cone', 'rectangle')
    expect(li.querySelector('[data-testid="slice-setting-unsupported"]')).toBeNull()
    expect(li.querySelector('select')!.hasAttribute('aria-describedby')).toBe(false)
  })

  it('marks rib on a printer whose tower is not type 1, and not on a Bambu Lab printer', () => {
    const def = settingDef('wipe_tower_wall_type')!
    const prusa = unavailableIn(def, { printer_model: 'Prusa CORE One', wipe_tower_type: 'type2' } as never)
    const bambu = unavailableIn(def, { printer_model: 'Bambu Lab A1', wipe_tower_type: 'type2' } as never)
    expect(unsupportedNote(def, 'rib', prusa)).toBe('Rib is unsupported on this printer; slicing uses Rectangle.')
    expect(unsupportedNote(def, 'rib', bambu)).toBeUndefined()
    expect(unsupportedNote(def, 'cone', prusa)).toBe('Cone is unsupported; slicing uses Rectangle.')
    expect(offeredValues(def, 'rectangle', prusa).map((o) => o.value)).toEqual(['rectangle'])
    expect(offeredValues(def, 'rectangle', bambu).map((o) => o.value)).toEqual(['rectangle', 'rib'])
    const li = wallRow('rib', undefined, prusa)
    const note = li.querySelector('[data-testid="slice-setting-unsupported"]')!
    expect(note.textContent).toBe('Rib is unsupported on this printer; slicing uses Rectangle.')
    expect(li.querySelector('select')!.getAttribute('aria-describedby')).toBe(note.id)
    expect([...li.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Rectangle', 'Rib (unsupported)'])
  })

  it('says what the engine builds for a type 2 prime tower, not the default type', () => {
    expect(unsupportedNote(settingDef('wipe_tower_type')!, 'type2')).toBe('Type 2 is unsupported; slicing uses a plain tower as wide as the prime tower width.')
  })
})
