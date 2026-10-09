// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Goal tiles in the Slice sidebar: each says what it gives on the printer in use, the picked tile's tooltip says
// about how long and how much from the last slice, and a moved control shows Custom with no tile picked.
import type { SliceResult } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { goalEasy } from '../src/adapters/config'
import { get, set, type AppState } from '../src/state/store'
import { EasySettingsPanel } from '../src/workspaces/prepare/easy-settings'

const result = { id: 'r1', stats: { timeS: 5760, filamentG: [148], filamentMm: [], cost: 2, toolChanges: 0 }, warnings: [] } as unknown as SliceResult

let el: HTMLDivElement
let root: Root
const initial = get()

function mount(): void {
  flushSync(() => root.render(createElement(EasySettingsPanel)))
}

const tile = (tier: string) => el.querySelector<HTMLElement>(`[data-testid="slice-goal-${tier}"]`)
const estimate = () => el.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.getAttribute('data-tip-body') ?? null
const chip = () => el.querySelector<HTMLElement>('.goal-custom')

beforeEach(() => {
  set({ settingsMode: 'simple', goal: 'standard', easy: goalEasy('standard'), easyTouched: [], profile: null, slice: { status: 'idle' } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  root.unmount()
  el.remove()
  set({ settingsMode: initial.settingsMode, goal: initial.goal, easy: initial.easy, easyTouched: initial.easyTouched, profile: initial.profile, slice: initial.slice })
})

describe('the Goal tiles', () => {
  it('are one radiogroup of four tiles, each with an icon, a label and what it gives in the mono face', () => {
    mount()
    expect(el.querySelectorAll('[role="radiogroup"][aria-label="Goal"]')).toHaveLength(1)
    const names = ['draft', 'standard', 'fine', 'strong'].map((t) => tile(t)?.querySelector('.goal-name')?.textContent)
    expect(names).toEqual(['Draft', 'Standard', 'Fine', 'Strong'])
    for (const t of ['draft', 'standard', 'fine', 'strong']) {
      expect(tile(t)?.getAttribute('role')).toBe('radio')
      expect(tile(t)?.querySelector('.sx-ic')).not.toBeNull()
      expect(tile(t)?.querySelector('.goal-sub.sx-mono')).not.toBeNull()
    }
    // Without a printer: SlicerX's own goals on a 0.4 mm nozzle.
    expect(tile('draft')?.querySelector('.goal-sub')?.textContent).toBe('0.28 mm')
    expect(tile('fine')?.querySelector('.goal-sub')?.textContent).toMatch(/^0\.1\d mm$/)
    expect(tile('strong')?.querySelector('.goal-sub')?.textContent).toMatch(/^\d walls$/)
    expect(tile('standard')?.getAttribute('aria-checked')).toBe('true')
  })

  it("read the printer's own numbers for each goal, so another nozzle shows other numbers", () => {
    const values = { draft: { layer_height: 0.42 }, standard: { layer_height: 0.3 }, fine: { layer_height: [0.18] }, strong: { layer_height: 0.3, wall_loops: 3 } }
    set({ profile: { printerId: 'bambu-p1s', nozzle: 0.6, nozzles: [0.4, 0.6], nozzleFrom: 'choice', tier: 'standard', source: 'orca', shippedGcode: true, gcodeKeys: [], limits: {}, goalValues: values } })
    mount()
    expect(['draft', 'standard', 'fine', 'strong'].map((t) => tile(t)?.querySelector('.goal-sub')?.textContent)).toEqual(['0.42 mm', '0.30 mm', '0.18 mm', '3 walls'])
  })

  it('show no estimate before a slice', () => {
    mount()
    expect(estimate()).toBeNull()
  })

  it('show about how long and how much from a fresh slice, and Updating while it is stale or slicing again', () => {
    set({ slice: { status: 'done', result, stale: false } })
    mount()
    expect(estimate()).toBe('About 1h 36m, 148 g from the last slice.')
    flushSync(() => set({ slice: { status: 'done', result, stale: true } }))
    expect(estimate()).toBe('Updating the estimate.')
    flushSync(() => set({ slice: { status: 'running', progress: null, startedAt: 0, last: result } }))
    expect(estimate()).toBe('Updating the estimate.')
    flushSync(() => set({ slice: { status: 'error', message: 'no' } }))
    expect(estimate()).toBeNull()
  })

  it('show Custom with no tile picked once a control moves, and picking a goal starts over', () => {
    mount()
    expect(chip()).toBeNull()
    flushSync(() => set({ goal: 'custom' as AppState['goal'], easy: { ...goalEasy('standard'), detail: 55 }, easyTouched: ['detail'] }))
    expect(el.querySelectorAll('[aria-label="Goal"] [role="radio"][aria-checked="true"]')).toHaveLength(0)
    expect(chip()?.textContent).toBe('Custom')
    expect(chip()?.getAttribute('data-tip')).toBe('You changed a setting the goal sets. Pick a goal to start over.')
    // The chip is a note, not another control.
    expect(chip()?.closest('button')).toBeNull()
    flushSync(() => tile('fine')?.click())
    expect(get().goal).toBe('fine')
    expect(get().easyTouched).toEqual([])
    expect(chip()).toBeNull()
    expect(tile('fine')?.getAttribute('aria-checked')).toBe('true')
  })
})
