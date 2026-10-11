// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Goal tiles in the Slice sidebar: each says what it gives on the printer in use, the picked tile's tooltip says
// about how long and how much from the last slice, and a moved control keeps the goal's tile picked, marked edited.
import type { SliceResult } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { goalConfig, goalEasy, resolveConfig } from '../src/adapters/config'
import { goalEdits, goalEditsText, nearestGoal } from '../src/lib/goal-edits'
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
const checked = () => [...el.querySelectorAll<HTMLElement>('[aria-label="Goal"] [role="radio"][aria-checked="true"]')].map((t) => t.dataset['testid'])
const dot = (tier: string) => tile(tier)?.querySelector('.goal-edited-dot') ?? null

beforeEach(() => {
  set({ settingsMode: 'simple', goal: 'standard', goalBase: 'standard', easy: goalEasy('standard'), easyTouched: [], overrides: {}, profile: null, slice: { status: 'idle' } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  root.unmount()
  el.remove()
  set({ settingsMode: initial.settingsMode, goal: initial.goal, goalBase: initial.goalBase, overrides: initial.overrides, easy: initial.easy, easyTouched: initial.easyTouched, profile: initial.profile, slice: initial.slice })
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

  it('keep the goal it started from picked, marked edited, with the changed settings in its tip', () => {
    mount()
    expect(chip()).toBeNull()
    expect(dot('standard')).toBeNull()
    flushSync(() => set({ goal: 'custom' as AppState['goal'], easy: { ...goalEasy('standard'), detail: 80 }, easyTouched: ['detail'] }))
    expect(checked()).toEqual(['slice-goal-standard'])
    expect(dot('standard')).not.toBeNull()
    expect(dot('fine')).toBeNull()
    expect(chip()?.textContent).toBe('Edited')
    // The chip is a note, not another control.
    expect(chip()?.closest('button')).toBeNull()
    const body = tile('standard')?.getAttribute('data-tip-body') ?? ''
    expect(body).toMatch(/^Changed from Standard: Layer height 0\.1\d mm \(Standard 0\.2 mm\)/)
    expect(body).toMatch(/Press Standard to go back to its settings\.$/)
    expect(chip()?.getAttribute('data-tip-body')).toBe(body)
  })

  it('go back to the stock values when the edited tile is pressed, overrides of what the goal sets included', () => {
    mount()
    flushSync(() => set({ goal: 'custom' as AppState['goal'], easy: { ...goalEasy('standard'), strength: 60 }, easyTouched: ['strength'], overrides: { wall_loops: 6, seam_position: 'back' } }))
    expect(dot('standard')).not.toBeNull()
    flushSync(() => tile('standard')?.click())
    expect(get().goal).toBe('standard')
    expect(get().easy).toEqual(goalEasy('standard'))
    expect(get().easyTouched).toEqual([])
    // What a goal decides goes back; other settings of the person's stay.
    expect(get().overrides).toEqual({ seam_position: 'back' })
    expect(chip()).toBeNull()
    expect(dot('standard')).toBeNull()
  })

  it('picking another goal starts over from it', () => {
    mount()
    flushSync(() => set({ goal: 'custom' as AppState['goal'], easy: { ...goalEasy('standard'), detail: 55 }, easyTouched: ['detail'] }))
    flushSync(() => tile('fine')?.click())
    expect(get().goal).toBe('fine')
    expect(get().easyTouched).toEqual([])
    expect(checked()).toEqual(['slice-goal-fine'])
    expect(chip()).toBeNull()
  })

  it('show no mark for settings that came back to the goal', () => {
    mount()
    flushSync(() => set({ goal: 'custom' as AppState['goal'], easy: goalEasy('fine'), goalBase: 'fine' }))
    expect(checked()).toEqual(['slice-goal-fine'])
    expect(dot('fine')).toBeNull()
    expect(chip()).toBeNull()
  })
})

describe('goal edits', () => {
  it('list only what a goal decides, the layer height first', () => {
    const cfg = { ...resolveConfig({ ...goalEasy('standard'), detail: 80 }, { seam_position: 'back', wall_loops: 5 }) }
    const edits = goalEdits(cfg, 'standard')
    expect(edits[0]?.key).toBe('layer_height')
    expect(edits.map((e) => e.key)).toContain('wall_loops')
    expect(edits.map((e) => e.key)).not.toContain('seam_position')
    expect(goalEdits(goalConfig('standard'), 'standard')).toEqual([])
  })

  it('say how many more past the first few', () => {
    const e = (k: string) => ({ key: k, label: k, now: '1', goal: '2' })
    expect(goalEditsText([e('a'), e('b')], 'Fine')).toBe('Changed from Fine: a 1 (Fine 2), b 1 (Fine 2). Press Fine to go back to its settings.')
    expect(goalEditsText(['a', 'b', 'c', 'd', 'e', 'f'].map(e), 'Fine')).toMatch(/d 1 \(Fine 2\) and 2 more\./)
  })

  it('start a project that matches no goal from the nearest by layer height', () => {
    expect(nearestGoal({ layer_height: 0.14 })).toBe('fine')
    expect(nearestGoal({ layer_height: 0.3 })).toBe('draft')
    // Standard and Strong share a height: Standard.
    expect(nearestGoal({ layer_height: 0.2 })).toBe('standard')
    expect(nearestGoal({ layer_height: 0.2 }, { draft: { layer_height: 0.3 }, standard: { layer_height: 0.24 }, fine: { layer_height: 0.18 }, strong: { layer_height: 0.24 } })).toBe('fine')
    expect(nearestGoal({})).toBe('standard')
  })
})
