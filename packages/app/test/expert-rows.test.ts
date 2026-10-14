// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Expert panel's rows for switches held as a list, text settings and settings that are a number or a percent:
// each renders, takes an edit, refuses what the setting cannot hold, and stores the value the engine and the project
// file read back. Saving a project writes them as Orca text; opening it brings the same values back.
import type { SettingDef, SettingValue } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SETTINGS, toOrca } from '../src/adapters/settings'
import { projectSettingChanges } from '../src/export/project-settings'
import { takenFromFile, textOk } from '../src/lib/setting-text'
import { ExpertSettings, Field, PROCESS_EDITABLE } from '../src/workspaces/prepare/expert-settings'
import { parseMmOrPercent, splitMmOrPercent } from '../src/workspaces/prepare/setting-rows'
import { get, set } from '../src/state/store'
import { plateSliceConfig } from '../src/state/slice-plate'

const def = (key: string): SettingDef => SETTINGS.find((d) => d.key === key)!

let root: Root | null = null
let el: HTMLElement | null = null
function render(node: Parameters<Root['render']>[0]): HTMLElement {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  flushSync(() => root!.render(node))
  return el
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
  set({ overrides: {}, settingsMode: 'advanced' })
})

/** A row for `key` holding `value`, and every value it sets. */
function row(key: string, value: SettingValue | undefined): { li: HTMLLIElement; sets: (SettingValue | undefined)[] } {
  const sets: (SettingValue | undefined)[] = []
  const host = render(createElement(Field, { def: def(key), value, overridden: false, onSet: (_k: string, v: SettingValue | undefined) => sets.push(v) }))
  return { li: host.querySelector('li')!, sets }
}

/** Types into a field and leaves it, as a person does. */
function typeIn(input: HTMLInputElement, text: string): void {
  flushSync(() => {
    input.focus()
    input.value = text
    input.blur()
  })
}

describe('the Expert panel lists the three value types', () => {
  it('takes switches held as a list, text settings and number-or-percent settings', () => {
    for (const t of ['bools', 'string', 'floatsOrPercents']) expect(PROCESS_EDITABLE.has(t)).toBe(true)
  })

  // The test page reads as a phone, which keeps to Simple; a changed setting is listed in any mode, so the rows are
  // reached through a change (the e2e tips spec opens them in Expert on a desktop page).
  it('lists each named setting as a row once the panel takes its type', () => {
    set({ settingsMode: 'expert', settingsTab: 'speed', overrides: { slowdown_for_curled_perimeters: [true], solid_infill_rotate_template: '0,90', small_perimeter_speed: ['40%'] } })
    const host = render(createElement(ExpertSettings))
    for (const [key, tab] of [['slowdown_for_curled_perimeters', 'speed'], ['solid_infill_rotate_template', 'strength'], ['small_perimeter_speed', 'speed']] as const) {
      flushSync(() => set({ settingsTab: tab }))
      expect(host.querySelector(`li[data-key="${key}"]`), key).not.toBeNull()
    }
  })
})

describe('a switch held as a list', () => {
  it('renders the first value and stores a list of one', () => {
    const { li, sets } = row('slowdown_for_curled_perimeters', [false])
    const sw = li.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    // A switch has no unit beside its label.
    expect(li.querySelector('.field-unit')).toBeNull()
    flushSync(() => sw.click())
    expect(sets).toEqual([[true]])
  })

  it('reads engine values that are numbers or strings as on', () => {
    for (const v of [[true], [1], ['1'], ['true']] as SettingValue[]) {
      const { li } = row('slowdown_for_curled_perimeters', v)
      expect(li.querySelector('[role="switch"]')!.getAttribute('aria-checked'), JSON.stringify(v)).toBe('true')
      flushSync(() => root!.unmount())
      el!.remove()
      root = null
    }
  })
})

describe('a text setting', () => {
  it('stacks a template under its label, across the row, and stores what was typed', () => {
    const { li, sets } = row('solid_infill_rotate_template', '')
    expect(li.hasAttribute('data-stack')).toBe(true)
    const input = li.querySelector<HTMLInputElement>('input.text')!
    expect(input.classList.contains('wide')).toBe(true)
    // Its unit (degrees) is written beside the label.
    expect(li.querySelector('.field-unit')!.textContent).toBe('°')
    typeIn(input, ' 0,90 ')
    expect(sets).toEqual(['0,90'])
  })

  it('refuses text the template language cannot read, and puts the value back', () => {
    const { li, sets } = row('solid_infill_rotate_template', '45')
    const input = li.querySelector<HTMLInputElement>('input.text')!
    expect(input.value).toBe('45')
    typeIn(input, 'zero then ninety')
    expect(sets).toEqual([])
    expect(input.value).toBe('45')
  })

  it('keeps a short value at the control column width', () => {
    const { li, sets } = row('extra_solid_infills', '')
    expect(li.hasAttribute('data-stack')).toBe(false)
    const input = li.querySelector<HTMLInputElement>('input.text')!
    expect(input.classList.contains('wide')).toBe(false)
    typeIn(input, '5#2')
    typeIn(input, '5;2')
    expect(sets).toEqual(['5#2'])
  })

  it('stores nothing when the text is unchanged, and Escape puts it back', () => {
    const { li, sets } = row('solid_infill_rotate_template', '0,90')
    const input = li.querySelector<HTMLInputElement>('input.text')!
    typeIn(input, '0,90')
    flushSync(() => {
      input.focus()
      input.value = '30'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sets).toEqual([])
    expect(input.value).toBe('0,90')
  })
})

describe('a number or percent setting', () => {
  it('shows the number with its unit picked in the toggle', () => {
    const { li } = row('small_perimeter_speed', ['50%'])
    const input = li.querySelector<HTMLInputElement>('.mm-or-pct input.num')!
    expect(input.value).toBe('50')
    const [abs, pct] = [...li.querySelectorAll<HTMLButtonElement>('.unit-seg [role="radio"]')]
    expect(abs!.textContent).toBe('mm/s')
    expect(pct!.getAttribute('aria-checked')).toBe('true')
    // The toggle names the unit, so the label does not.
    expect(li.querySelector('.field-unit')).toBeNull()
  })

  it('stores an edit in the unit shown, as a list of one string', () => {
    const { li, sets } = row('small_perimeter_speed', ['50%'])
    typeIn(li.querySelector<HTMLInputElement>('.mm-or-pct input.num')!, '40')
    expect(sets).toEqual([['40%']])
  })

  it('switches the unit and keeps the number', () => {
    const { li, sets } = row('small_perimeter_speed', ['50%'])
    const [abs] = [...li.querySelectorAll<HTMLButtonElement>('.unit-seg [role="radio"]')]
    flushSync(() => abs!.click())
    expect(sets).toEqual([['50']])
  })

  it('takes a typed percent sign as the percent unit', () => {
    const { li, sets } = row('small_perimeter_speed', ['25'])
    expect(li.querySelector('.unit-seg [aria-checked="true"]')!.textContent).toBe('mm/s')
    typeIn(li.querySelector<HTMLInputElement>('.mm-or-pct input.num')!, '30%')
    expect(sets).toEqual([['30%']])
  })

  it('refuses what is not a number and keeps to the setting\'s limits', () => {
    const { li, sets } = row('small_perimeter_speed', ['25'])
    const input = li.querySelector<HTMLInputElement>('.mm-or-pct input.num')!
    typeIn(input, 'fast')
    expect(input.value).toBe('25')
    typeIn(input, '-5')
    // small_perimeter_speed starts at 1 mm/s.
    expect(sets).toEqual([['1']])
  })

  it('names the unit of an acceleration', () => {
    const { li } = row('bridge_acceleration', ['50%'])
    expect(li.querySelector('.unit-seg [role="radio"]')!.textContent).toBe('mm/s²')
  })

  it('splits and parses values as the engine writes them', () => {
    expect(splitMmOrPercent(['150%'])).toEqual({ num: '150', percent: true })
    expect(splitMmOrPercent('0')).toEqual({ num: '0', percent: false })
    expect(splitMmOrPercent(undefined)).toEqual({ num: '', percent: false })
    expect(parseMmOrPercent(def('internal_bridge_speed'), '2.5', false)).toEqual(['2.5'])
    expect(parseMmOrPercent(def('internal_bridge_speed'), '', true)).toBeUndefined()
  })
})

describe('the values a project file carries', () => {
  /** The values written to project_settings.config, then read back on open over a config that holds the defaults. */
  function roundTrip(values: Record<string, SettingValue>): Record<string, SettingValue> {
    const file: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) file[k] = toOrca(def(k), v)
    const now = Object.fromEntries(Object.keys(values).map((k) => [k, def(k).default])) as never
    return projectSettingChanges(file, now).values
  }

  it('come back as they were saved', () => {
    const saved = { slowdown_for_curled_perimeters: [true], solid_infill_rotate_template: '0,90', sparse_infill_rotate_template: '+5#5', extra_solid_infills: '5#2', small_perimeter_speed: ['40%'], internal_bridge_speed: ['30'] } as Record<string, SettingValue>
    expect(roundTrip(saved)).toEqual(saved)
  })

  it('reach the slice as they were set', () => {
    const edits = { slowdown_for_curled_perimeters: [true], solid_infill_rotate_template: '0,90', small_perimeter_speed: ['40%'] } as Record<string, SettingValue>
    const config = plateSliceConfig({ ...get(), overrides: edits }, undefined) as Record<string, SettingValue>
    for (const [k, v] of Object.entries(edits)) expect(config[k], k).toEqual(v)
  })

  it('bring no free text and no template the app cannot read', () => {
    expect(roundTrip({ notes: 'hello', solid_infill_rotate_template: '0,90; M500' } as Record<string, SettingValue>)).toEqual({})
    expect(takenFromFile('filename_format', '{input_filename_base}.gcode')).toBe(false)
    expect(textOk('notes', 'two\nlines')).toBe(false)
    expect(textOk('notes', 'one line')).toBe(true)
  })
})
