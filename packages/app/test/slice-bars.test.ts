// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The slicing bar over the viewport and the Estimate block's bar show the same progress. The browser pool reports one
// stage, paths, with a fraction for the whole slice; the bar over the viewport spread it across all eight engine
// stages, so it started at 62.5% while the Estimate bar started at 0.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { set } from '../src/state/store'
import { SliceProgress, sliceFraction } from '../src/workspaces/slice-progress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('the slicing bars', () => {
  it.each([0, 0.1, 0.55, 1])('agree for the pool\'s paths fraction %s', async (fraction) => {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    set({ slice: { status: 'idle' }, plateLoading: false })
    await act(async () => root.render(createElement(SliceProgress)))
    const progress = { stage: 'paths' as const, fraction }
    await act(async () => set({ slice: { status: 'running', progress, startedAt: 0 } }))
    await act(() => new Promise((r) => setTimeout(r, 300)))
    const top = Number(el.querySelector('.slice-progress')?.getAttribute('aria-valuenow'))
    // The Estimate bar draws sliceFraction(progress) (prepare-panes.tsx).
    expect(top).toBe(Math.round(sliceFraction(progress) * 100))
    expect(top).toBe(Math.round(fraction * 100))
    await act(async () => root.unmount())
    el.remove()
  })
})
