// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// With tooltips off in Settings, ? still summons the tip under the pointer. The tip text loads on its own after
// startup, so the first ? finds it without a hover having asked for it first.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppTooltips, tipsLoaded } from '../src/lib/tip-host'
import { get, set } from '../src/state/store'

let host: HTMLDivElement
let root: Root
let move: HTMLButtonElement
const before = get().tooltips

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  set({ tooltips: { enabled: false, media: true } })
  move = document.createElement('button')
  move.setAttribute('data-tip', 'tool.move')
  move.textContent = 'Move'
  document.body.append(move)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  move.remove()
  set({ tooltips: before })
})

describe('summoning a tip with tooltips off', () => {
  it('loads the tip text after startup, so the first ? shows the tip', async () => {
    expect(tipsLoaded()).toBe(false)
    act(() => root.render(createElement(AppTooltips)))
    await vi.waitFor(() => expect(tipsLoaded()).toBe(true), { timeout: 20_000 })
    act(() => void move.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    const press = new KeyboardEvent('keydown', { key: '?', shiftKey: true, cancelable: true })
    act(() => void window.dispatchEvent(press))
    // The tip takes the key, so the app's own ? (the shortcut list) does not open as well.
    expect(press.defaultPrevented).toBe(true)
    expect(document.getElementById('sx-tip')?.textContent).toContain('Move')
  })
})
