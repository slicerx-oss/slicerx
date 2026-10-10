// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sidebar's slice footer says why Print or Export is held back, also before any slice has finished: a plate
// refused by the by-object check never slices, so the compact footer is the only place the reason can show.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HostContext } from '../src/host'
import { get, set } from '../src/state/store'
import { SliceBlock } from '../src/workspaces/prepare/prepare-panes'

const host = { kind: 'web', capabilities: { threads: 4 } } as never
const before = get()

const roots: Root[] = []

// The roots go before the store is put back, so no render lands after the test's DOM is gone.
afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
  set({ slice: before.slice, plate: before.plate, autoSlice: before.autoSlice, sliceHeld: false })
})

function footer(compact: boolean): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  const client = new QueryClient()
  flushSync(() => root.render(createElement(QueryClientProvider, { client }, createElement(HostContext.Provider, { value: host }, createElement(SliceBlock, { compact })))))
  return el
}

describe('slice footer', () => {
  for (const compact of [true, false]) {
    it(`shows a refused slice's reason ${compact ? 'in the sidebar footer' : 'in the estimate block'}`, () => {
      const box = { id: 'b', name: 'Box', parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
      set({ plate: [box] as never, autoSlice: true, slice: { status: 'error', message: 'The slicer stopped: Box has no walls.' } as never })
      const el = footer(compact)
      expect([...el.querySelectorAll('.app-err')].map((p) => p.textContent)).toContain('The slicer stopped: Box has no walls.')
      el.remove()
    })
  }

  it('with a big plate held by Auto slice, Slice is the action and a quiet line says why', () => {
    const box = { id: 'b', name: 'Box', parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
    set({ plate: [box] as never, autoSlice: true, sliceHeld: true, slice: { status: 'idle' } })
    const el = footer(true)
    expect(el.querySelector('[data-testid="slice-estimate-held"]')?.textContent).toBe('A big plate: it slices when you press Slice.')
    expect(el.querySelector('[data-testid="slice-estimate-slice"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="danger-slice-print"]')).toBeNull()
    el.remove()
  })
})
