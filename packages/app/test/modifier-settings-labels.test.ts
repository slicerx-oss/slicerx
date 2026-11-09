// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modifier's "Add setting" search shows a setting's plain label. The internal key still matches what you type,
// but it is never printed in a result.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ModifierSettings } from '../src/workspaces/prepare/object-volumes'
import { HostContext } from '../src/host'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlateVolumeEntry } from '../src/state/store'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const v = { id: 'v1', settings: {} } as unknown as PlateVolumeEntry
  const tree = createElement(HostContext.Provider, { value: { kind: 'web', capabilities: {} } as never }, createElement(ModifierSettings, { objectId: 'o1', v }))
  flushSync(() => createRoot(el).render(createElement(QueryClientProvider, { client: new QueryClient() }, tree)))
  return el
}

function type(input: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  flushSync(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the modifier setting search', () => {
  it('lists plain labels only, and still finds a setting by its key', () => {
    const el = mount()
    flushSync(() => el.querySelector<HTMLButtonElement>('[aria-expanded]')!.click())
    const input = el.querySelector<HTMLInputElement>('input.sx-input')!
    type(input, 'infill')
    const rows = [...el.querySelectorAll('.obj-set-hits button')]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.querySelector('.sx-mono')).toBeNull()
    type(input, 'sparse_infill_density')
    const byKey = [...el.querySelectorAll('.obj-set-hits button')]
    expect(byKey.length).toBeGreaterThan(0)
    for (const r of byKey) {
      expect(r.querySelector('.sx-mono')).toBeNull()
      expect(r.textContent).not.toContain('sparse_infill_density')
    }
  })
})
