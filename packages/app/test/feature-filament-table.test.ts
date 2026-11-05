// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Color tab's feature filament table: one home for the per-feature filament settings, the object's filament by
// default, written to the plate or the selected objects through the scope, "Mixed" across a selection that differs,
// and what each feature printed with read from the current slice.
import type { FeatureFilaments, SliceResult } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setSettingsView } from '../src/agent-bridge/settings'
import { appState } from '../src/agent-bridge/page'
import { normalizePrefs } from '../src/state/prefs'
import { FEATURE_FILAMENT_KEYS, FEATURE_FILAMENT_ROWS, featureFilamentRows, setFeatureFilament } from '../src/plate/feature-filaments'
import { RANGE_KEYS } from '../src/plate/layer-ranges'
import { get, set } from '../src/state/store'
import { FeatureFilamentTable, featureFilamentSummary } from '../src/workspaces/prepare/feature-filament-table'
import { buildTabs, colorChanged, offeredTabs, sectionOpen, settingsView } from '../src/workspaces/prepare/settings-view'

const obj = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, handle: { id, parts: [{ name: 'body', slot: 1 }] }, parts: [], colors: [], ...extra }) as never
const PLATE = { outer_wall_filament_id: 0, support_filament: 0 }
const none = () => false

/** A finished slice whose report says what each object's features printed with. */
const sliced = (report: FeatureFilaments[], stale = false) => set({ slice: { status: 'done', stale, result: { featureFilaments: report } as unknown as SliceResult } })

beforeEach(() => {
  set({ plate: [obj('a'), obj('b', { handle: { id: 'b', parts: [{ name: 'body', slot: 2 }] } }), obj('c', { instanceOf: 'a' })], objectSettings: {}, overrides: {}, slice: { status: 'idle' }, settingsScope: 'plate', selection: null, selectedIds: [], scopePart: null, settingsPins: [] })
})

describe('the feature filament settings have one home', () => {
  it('puts all eight in the Color tab as one table, in Simple, Advanced and Expert, and lists none as rows', () => {
    for (const mode of ['simple', 'advanced', 'expert'] as const) {
      const tabs = buildTabs({ mode, changed: none, filamentCount: 2, searching: false })
      const color = tabs.find((t) => t.intent.id === 'multicolor')!
      const features = color.sections.find((s) => s.id === 'features')!
      expect(features.table?.map((d) => d.key).sort()).toEqual([...FEATURE_FILAMENT_KEYS].sort())
      const rows = tabs.flatMap((t) => t.sections.flatMap((s) => [...s.shown, ...s.more].map((d) => d.key)))
      expect(rows.filter((k) => FEATURE_FILAMENT_KEYS.has(k))).toEqual([])
    }
  })

  it('opens the table\'s section by default, beside the first section with rows', () => {
    const tabs = buildTabs({ mode: 'advanced', changed: none, filamentCount: 2, searching: false })
    const color = tabs.find((t) => t.intent.id === 'multicolor')!
    const o = { mode: 'advanced' as const, changed: none }
    expect(sectionOpen({}, color, color.sections.find((s) => s.id === 'features')!, o)).toBe(true)
    expect(sectionOpen({}, color, color.sections.find((s) => s.id === 'tower')!, o)).toBe(true)
    expect(sectionOpen({ 'multicolor/features': false }, color, color.sections.find((s) => s.id === 'features')!, o)).toBe(false)
  })

  it('has no table with one filament', () => {
    const tabs = buildTabs({ mode: 'expert', changed: none, filamentCount: 1, searching: false })
    expect(tabs.find((t) => t.intent.id === 'multicolor')!.sections.find((s) => s.id === 'features')!.table).toBeUndefined()
  })

  it('shares its wall, infill and surface keys with the height ranges, which leave support plate-wide', () => {
    expect(RANGE_KEYS.filter((k) => FEATURE_FILAMENT_KEYS.has(k))).toEqual(['outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id', 'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id'])
    expect(RANGE_KEYS).toHaveLength(20)
  })

  it('names the rows in plain words', () => {
    expect(FEATURE_FILAMENT_ROWS.map((r) => r.label)).toEqual(['Outer wall', 'Inner wall', 'Sparse infill', 'Solid infill', 'Top surface', 'Bottom surface', 'Support', 'Support interface'])
  })
})

describe('reading and writing the table through the scope', () => {
  it("reads the object's filament (0) by default", () => {
    const rows = featureFilamentRows(get(), PLATE, { kind: 'plate' })
    expect(rows).toHaveLength(8)
    for (const r of rows) expect(r).toMatchObject({ value: 0, source: 'plate', changed: false, printedWith: null })
  })

  it('writes the plate scope to the plate settings, and the selection scope to each source object', () => {
    setFeatureFilament(get(), { kind: 'plate' }, 'support_filament', 2)
    expect(get().overrides).toEqual({ support_filament: 2 })
    expect(get().objectSettings).toEqual({})

    // c is an instance of a: the selection writes once per source
    setFeatureFilament(get(), { kind: 'objects', ids: ['c'] }, 'outer_wall_filament_id', 3)
    expect(get().objectSettings).toEqual({ a: { outer_wall_filament_id: 3 } })
    expect(get().overrides).toEqual({ support_filament: 2 })

    // undefined goes back: the plate's edit to the Easy value, the object's own to the plate's
    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', undefined)
    setFeatureFilament(get(), { kind: 'plate' }, 'support_filament', undefined)
    expect(get().objectSettings).toEqual({})
    expect(get().overrides).toEqual({})
    expect(() => setFeatureFilament(get(), { kind: 'plate' }, 'wall_loops', 2)).toThrow()
  })

  it('reads Mixed across a selection that differs, and marks what the selection set itself', () => {
    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', 2)
    const both = featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['a', 'b'] })
    expect(both.find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: undefined, source: 'mixed', changed: false })
    expect(both.find((r) => r.key === 'support_filament')).toMatchObject({ value: 0, source: 'plate', changed: false })
    const one = featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['a'] })
    expect(one.find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: 2, source: 'own', changed: true, plateValue: 0 })
  })
})

describe('the edge cases of a scope', () => {
  it('does not call objects mixed when they print with the same slot: an explicit 0 beside an unset one, or 2 beside "2"', () => {
    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', 0)
    expect(featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['a', 'b'] }).find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: 0, source: 'plate' })
    set({ objectSettings: { a: { outer_wall_filament_id: 2 }, b: { outer_wall_filament_id: '2' } } })
    expect(featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['a', 'b'] }).find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: 2, source: 'own', changed: true })
  })

  it("marks a part's row only for the part's own value, and shows no printed-with for a part", () => {
    setFeatureFilament(get(), { kind: 'objects', ids: ['b'] }, 'outer_wall_filament_id', 3)
    // a current slice that printed b's outer wall with 1 and 3: still nothing for one part of b
    sliced([{ object: 'b', name: 'b', features: { outerWall: [1, 3] } }])
    expect(featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['b'] }).find((r) => r.key === 'outer_wall_filament_id')!.printedWith).toEqual([1, 3])
    const part = { kind: 'part', id: 'b', part: 'body' } as const
    const inherited = featureFilamentRows(get(), PLATE, part).find((r) => r.key === 'outer_wall_filament_id')!
    expect(inherited).toMatchObject({ value: 3, changed: false, printedWith: null })
    setFeatureFilament(get(), part, 'outer_wall_filament_id', 1)
    expect(featureFilamentRows(get(), PLATE, part).find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: 1, changed: true })
  })

  it('says mixed in the closed summary', () => {
    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', 2)
    expect(featureFilamentSummary(featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['a', 'b'] }), [])).toBe('outer wall mixed')
    expect(featureFilamentSummary(featureFilamentRows(get(), PLATE, { kind: 'plate' }), [])).toBe("Object's filament")
  })

  it('keeps the Color tab, and the table, while a feature filament change remains on a one-filament plate', () => {
    const changed = (k: string) => k === 'support_filament'
    const tabs = buildTabs({ mode: 'advanced', changed, filamentCount: 1, searching: false })
    expect(colorChanged(tabs, changed)).toBe(true)
    expect(offeredTabs(1, colorChanged(tabs, changed)).map((t) => t.id)).toContain('multicolor')
    expect(offeredTabs(1).map((t) => t.id)).not.toContain('multicolor')
    expect(tabs.find((t) => t.intent.id === 'multicolor')!.sections.find((s) => s.id === 'features')!.table?.map((d) => d.key)).toEqual(['support_filament'])
  })
})

describe('printed with', () => {
  const report: FeatureFilaments[] = [
    { object: 'a', name: 'a', features: { outerWall: [2], innerWall: [1], support: [3] } },
    { object: 'b', name: 'b', features: { outerWall: [1], innerWall: [1] } },
  ]

  it('reads each feature from the current slice, for the plate or the selection', () => {
    sliced(report)
    const plate = featureFilamentRows(get(), PLATE, { kind: 'plate' })
    expect(Object.fromEntries(plate.map((r) => [r.feature, r.printedWith]))).toMatchObject({ outerWall: [1, 2], innerWall: [1], support: [3], sparseInfill: [] })
    const b = featureFilamentRows(get(), PLATE, { kind: 'objects', ids: ['b'] })
    expect(b.find((r) => r.feature === 'outerWall')!.printedWith).toEqual([1])
    expect(b.find((r) => r.feature === 'support')!.printedWith).toEqual([])
  })

  it('shows nothing once the slice is stale', () => {
    sliced(report, true)
    for (const r of featureFilamentRows(get(), PLATE, { kind: 'plate' })) expect(r.printedWith).toBeNull()
  })
})

describe('the table on screen', () => {
  let el: HTMLDivElement
  let root: Root
  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    el.remove()
    document.body.replaceChildren()
  })
  const show = (scope: Parameters<typeof FeatureFilamentTable>[0]['scope']) => flushSync(() => root.render(createElement(FeatureFilamentTable, { scope, config: PLATE })))
  const row = (key: string) => el.querySelector<HTMLElement>(`[data-testid="slice-feature-filament-row"][data-key="${key}"]`)!
  const face = (key: string) => row(key).querySelector('[data-testid="slice-feature-filament-pick"]')!.textContent

  it("shows the object's filament by default, Mixed across a differing selection, and the selection's own value marked", () => {
    show({ kind: 'plate' })
    expect(el.querySelectorAll('[data-testid="slice-feature-filament-row"]')).toHaveLength(8)
    expect(face('outer_wall_filament_id')).toBe("Object's filament")
    // plain labels only, never setting keys, in the text or what a screen reader or a tip says
    expect(el.textContent).not.toMatch(/_filament/)
    for (const n of el.querySelectorAll('[aria-label], [data-tip-title], [data-tip-body]')) for (const a of ['aria-label', 'data-tip-title', 'data-tip-body']) expect(n.getAttribute(a) ?? '').not.toMatch(/_filament/)

    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', 2)
    show({ kind: 'objects', ids: ['a', 'b'] })
    expect(face('outer_wall_filament_id')).toBe('Mixed')
    expect(row('outer_wall_filament_id').dataset['source']).toBe('mixed')
    show({ kind: 'objects', ids: ['a'] })
    expect(row('outer_wall_filament_id').dataset['source']).toBe('own')
    expect(row('outer_wall_filament_id').querySelector('.sx-setrow-dot')).not.toBeNull()
    expect(row('support_filament').querySelector('.sx-setrow-dot')).toBeNull()
  })

  it('gives each pick the id a jump to the setting looks for, named by its row', () => {
    show({ kind: 'plate' })
    const pick = document.getElementById('set-support_interface_filament')!
    expect(pick.dataset['testid']).toBe('slice-feature-filament-pick')
    expect(el.querySelector('label[for="set-support_interface_filament"]')!.textContent).toBe('Support interface')
  })

  it('shows the plate scope chips of objects that print a row with their own filament', () => {
    flushSync(() => root.render(createElement(FeatureFilamentTable, { scope: { kind: 'plate' }, config: PLATE, chips: (k: string) => (k === 'outer_wall_filament_id' ? createElement('button', { className: 'obj-chip' }, 'a 3') : null) })))
    expect(row('outer_wall_filament_id').querySelector('.obj-chip')!.textContent).toBe('a 3')
    expect(row('support_filament').querySelector('.obj-chip')).toBeNull()
    // the selection's own scope has no chips
    flushSync(() => root.render(createElement(FeatureFilamentTable, { scope: { kind: 'objects', ids: ['a'] }, config: PLATE, chips: () => createElement('button', { className: 'obj-chip' }, 'x') })))
    expect(el.querySelector('.obj-chip')).toBeNull()
  })

  it('writes the picked slot to the scope from the menu', () => {
    show({ kind: 'objects', ids: ['b'] })
    flushSync(() => row('sparse_infill_filament_id').querySelector<HTMLElement>('[data-testid="slice-feature-filament-pick"]')!.click())
    const option = document.querySelector<HTMLElement>('[data-testid="slice-feature-filament-option"][data-value="2"]')!
    flushSync(() => option.click())
    expect(get().objectSettings).toEqual({ b: { sparse_infill_filament_id: 2 } })
    expect(get().overrides).toEqual({})
  })

  it('shows the printed-with swatches only while the slice is current', () => {
    show({ kind: 'plate' })
    expect(el.querySelector('[data-testid="slice-feature-filament-printed"]')).toBeNull()
    sliced([{ object: 'a', name: 'a', features: { outerWall: [2, 3] } }])
    show({ kind: 'plate' })
    expect(row('outer_wall_filament_id').querySelector<HTMLElement>('[data-testid="slice-feature-filament-printed"]')!.dataset['slots']).toBe('2,3')
    expect(row('support_filament').querySelector('[data-testid="slice-feature-filament-printed"]')!.textContent).toBe('None')
  })
})

describe('the agent bridge reads the table back', () => {
  it('reports the scope, each row with its key and value, and what printed it', () => {
    setFeatureFilament(get(), { kind: 'plate' }, 'support_filament', 2)
    sliced([{ object: 'a', name: 'a', features: { support: [2] } }])
    const view = settingsView(get())['featureFilaments'] as { scope: unknown; rows: { key: string; value: number | null; source: string; printedWith: number[] | null }[] }
    expect(view.scope).toEqual({ kind: 'plate' })
    expect(view.rows.find((r) => r.key === 'support_filament')).toMatchObject({ value: 2, source: 'plate', printedWith: [2] })

    setFeatureFilament(get(), { kind: 'objects', ids: ['a'] }, 'outer_wall_filament_id', 3)
    set({ selection: 'a', selectedIds: ['a', 'b'], settingsScope: 'objects' })
    const sel = settingsView(get())['featureFilaments'] as typeof view
    expect(sel.scope).toEqual({ kind: 'objects', objects: ['a', 'b'] })
    expect(sel.rows.find((r) => r.key === 'outer_wall_filament_id')).toMatchObject({ value: null, source: 'mixed' })
  })

  it('carries the table in app_state and app_settings_view, rows in the order the pick index follows', () => {
    const rows = (v: unknown) => (v as { featureFilaments: { rows: { key: string }[] } }).featureFilaments.rows.map((r) => r.key)
    // app_state reads the whole app; this file's plate fixtures are too thin for it, so it reads an empty plate
    set({ plate: [] })
    expect(rows(appState(get())['settings'])).toEqual(FEATURE_FILAMENT_ROWS.map((r) => r.key))
    expect(rows(setSettingsView({}))).toEqual(FEATURE_FILAMENT_ROWS.map((r) => r.key))
  })

  it('does not pin a feature filament setting, but takes off one pinned before, and drops such pins as preferences load', () => {
    expect(() => setSettingsView({ pin: ['support_filament'] })).toThrow(/cannot be pinned/)
    set({ settingsPins: ['support_filament', 'seam_position'] })
    expect((settingsView(get())['pins'] as { key: string }[]).map((p) => p.key)).toEqual(['seam_position'])
    setSettingsView({ unpin: ['support_filament'] })
    expect(get().settingsPins).toEqual(['seam_position'])
    expect(normalizePrefs({ settingsPins: ['outer_wall_filament_id', 'seam_position'] }).settingsPins).toEqual(['seam_position'])
  })
})
