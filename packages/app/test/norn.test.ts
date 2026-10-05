// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { FEATURE, type Host, type PreviewBuffers, type SliceResult } from '@slicerx/contracts'
import { settingDef } from '@slicerx/settings'
import { HostContext } from '../src/host'
import { formatDuration, formatGrams } from '../src/lib/preview-stats'
import { NornBar } from '../src/norn/norn-layer'
import { diffText, FEATURE_SETTINGS, settingsFor } from '../src/norn/norn-map'
import { layersAfterSlice } from '../src/state/actions'
import { Field } from '../src/workspaces/prepare/expert-settings'
import { get, set } from '../src/state/store'

describe('norn', () => {
  it('maps every toolpath feature to settings that exist', () => {
    for (const id of Object.values(FEATURE)) {
      const f = settingsFor(id)
      expect(f.name, String(id)).not.toBe('Toolpath')
      for (const key of f.keys) expect(settingDef(key), `${f.name}: ${key}`).toBeDefined()
    }
    expect(Object.keys(FEATURE_SETTINGS)).toHaveLength(Object.keys(FEATURE).length)
    expect(settingsFor(FEATURE.sparseInfill).keys[0]).toBe('sparse_infill_density')
    expect(settingsFor(99)).toEqual({ name: 'Toolpath', keys: [] })
  })

  it('says what a change cost in plain words', () => {
    expect(diffText(3600, 3360, formatDuration, 30)).toBe(`${formatDuration(240)} less`)
    expect(diffText(20, 21.25, formatGrams, 0.05)).toBe(`${formatGrams(1.25)} more`)
    expect(diffText(3600, 3610, formatDuration, 30)).toBe('the same')
  })
})

describe('norn before and after bar', () => {
  const stats = (timeS: number, grams: number) => ({ timeS, filamentG: [grams], filamentMm: [0], cost: 0, toolChanges: 0 }) as unknown as SliceResult['stats']
  const result = (timeS: number, grams: number) => ({ id: 'r1', engine: 'sx', layerCount: 1, layerZ: new Float32Array(1), layerTimeS: new Float32Array(1), stats: stats(timeS, grams), stageMicros: {}, wallMs: 1, warnings: [] }) as unknown as SliceResult
  const preview = { segmentCount: 0 } as unknown as PreviewBuffers
  const host = { slicer: { slice: () => new Promise(() => undefined) } } as unknown as Host

  function mount(): HTMLElement {
    const el = document.createElement('div')
    document.body.append(el)
    flushSync(() => createRoot(el).render(createElement(HostContext.Provider, { value: host }, createElement(NornBar))))
    return el
  }
  const button = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement

  it('shows what the change cost, the old paths on request, and puts the settings back on Undo', () => {
    set({ autoSlice: true, overrides: { wall_loops: 4 }, slice: { status: 'done', result: result(3360, 21.25), stale: false }, norn: { pick: null, ghost: false, before: { timeS: 3600, grams: 20, preview, overrides: { wall_loops: 2 }, objectSettings: {} } } })
    const el = mount()
    expect(el.textContent).toContain(`${formatDuration(240)} less`)
    expect(el.textContent).toContain(`${formatGrams(1.25)} more`)
    flushSync(() => button(el, 'Show the old paths').click())
    expect(get().norn.ghost).toBe(true)
    flushSync(() => button(el, 'Undo change').click())
    expect(get().overrides).toEqual({ wall_loops: 2 })
    expect(get().norn).toMatchObject({ before: null, ghost: false })
    el.remove()
  })

  it('waits for the new slice before it compares', () => {
    set({ slice: { status: 'done', result: result(3360, 21.25), stale: true }, norn: { pick: null, ghost: false, before: { timeS: 3600, grams: 20, preview, overrides: {}, objectSettings: {} } } })
    const el = mount()
    expect(el.textContent).toContain('Slicing with your change')
    expect(button(el, 'old paths').disabled).toBe(true)
    el.remove()
  })

  it('keeps the layer being edited after a change, clamped to the new stack', () => {
    const prev = { layerHi: 40, layerLo: 12, moveCut: 0.5 }
    expect(layersAfterSlice(prev, 100, false)).toEqual({ layerHi: 100, layerLo: 1, moveCut: 1 })
    expect(layersAfterSlice(prev, 100, true)).toEqual(prev)
    expect(layersAfterSlice(prev, 30, true)).toEqual({ layerHi: 30, layerLo: 12, moveCut: 0.5 })
    expect(layersAfterSlice(prev, 8, true)).toEqual({ layerHi: 8, layerLo: 8, moveCut: 0.5 })
    expect(layersAfterSlice({ layerHi: 0, layerLo: 1, moveCut: 1 }, 50, true)).toEqual({ layerHi: 50, layerLo: 1, moveCut: 1 })
  })

  it('selects a number field on focus so typing replaces the value', () => {
    const def = settingDef('wall_loops')!
    const el = document.createElement('div')
    document.body.append(el)
    flushSync(() => createRoot(el).render(createElement('ul', null, createElement(Field, { def, value: 15, overridden: false, onSet: () => {} }))))
    const input = el.querySelector('input') as HTMLInputElement
    input.focus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    el.remove()
  })
})
