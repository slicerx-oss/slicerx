// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Compare presets when the parent preset fails to load: the panel says so, and picking Parent again loads it.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { set } from '../src/state/store'

let fail = true
vi.mock('../src/presets/compare', async (orig) => {
  const real = await orig<typeof import('../src/presets/compare')>()
  return {
    ...real,
    parentFor: vi.fn(async (p: Parameters<typeof real.parentFor>[0]) => {
      if (fail) {
        fail = false
        throw new Error('the vendor file did not load')
      }
      return real.parentFor(p)
    }),
  }
})

describe('Compare presets with a parent that fails to load', () => {
  it('says so, and loads it when Parent is picked again', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { ComparePanel } = await import('../src/presets/compare-panel')
    set({ userPresets: [{ id: 'a', kind: 'filament', name: 'My PLA', values: { nozzle_temperature: [231] }, inherits: 'Bambu PLA Basic @BBL A1', createdAt: 1, updatedAt: 1 }], toast: null })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    const pick = (id: string, value: string) =>
      act(() => {
        const el = host.querySelector<HTMLSelectElement>(`#${id}`)!
        el.value = value
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
    const until = async (ok: () => boolean) => {
      for (let t = Date.now(); !ok(); ) {
        if (Date.now() - t > 20_000) throw new Error('timed out')
        await act(async () => void (await new Promise((r) => setTimeout(r, 20))))
      }
    }
    pick('cmp-kind', 'filament')
    pick('cmp-a', 'a')
    pick('cmp-b', 'parent')
    await until(() => /Could not read/.test(host.textContent ?? ''))
    expect(host.textContent).toContain('Could not read Bambu PLA Basic @BBL A1. Pick Parent again to try once more.')
    pick('cmp-b', 'stock')
    pick('cmp-b', 'parent')
    await until(() => host.querySelectorAll('[data-testid="preset-compare-row"]').length > 0)
    expect(host.textContent).not.toContain('Could not read')
    act(() => root.unmount())
    host.remove()
  })
})
