// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A toast with a button waits while it is hovered or focused and runs on with the time it had left; a plain toast
// leaves on time.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastClock, ToastProvider, useToast, type ToastOptions } from '../src/components/toast'

describe('the toast clock', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('stops while held and runs on with the time left', () => {
    const done = vi.fn()
    const c = new ToastClock(8000, done)
    vi.advanceTimersByTime(5000)
    c.hold('pointer')
    vi.advanceTimersByTime(60_000)
    expect(done).not.toHaveBeenCalled()
    c.release('pointer')
    vi.advanceTimersByTime(2999)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledOnce()
  })

  it('waits until both pointer and focus let go', () => {
    const done = vi.fn()
    const c = new ToastClock(1000, done)
    c.hold('pointer')
    c.hold('focus')
    c.release('pointer')
    vi.advanceTimersByTime(5000)
    expect(done).not.toHaveBeenCalled()
    c.release('focus')
    vi.advanceTimersByTime(1000)
    expect(done).toHaveBeenCalledOnce()
  })
})

describe('toasts on screen', () => {
  let host: HTMLDivElement
  let root: Root
  let post: (text: string, options?: ToastOptions) => void = () => {}
  function Poster() {
    const toast = useToast()
    useEffect(() => void (post = toast), [toast])
    return null
  }
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(<ToastProvider><Poster /></ToastProvider>))
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })
  const shown = () => host.querySelectorAll('[data-testid=toast]').length
  const ptr = (type: string) => new ((globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent)(type, { bubbles: true })

  it('keeps a toast with a button while hovered or focused', () => {
    act(() => post('Loaded as one object', { action: { label: 'Keep separate', run: () => {} }, duration: 8000 }))
    const el = host.querySelector<HTMLElement>('[data-testid=toast]')!
    act(() => void el.dispatchEvent(ptr('pointerover')))
    act(() => void vi.advanceTimersByTime(30_000))
    expect(shown()).toBe(1)
    act(() => void el.dispatchEvent(ptr('pointerout')))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-action]')!.focus())
    act(() => void vi.advanceTimersByTime(30_000))
    expect(shown()).toBe(1)
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-action]')!.blur())
    act(() => void vi.advanceTimersByTime(8000))
    expect(shown()).toBe(0)
  })

  it('lets a plain toast go on time, hovered or not', () => {
    act(() => post('Saved'))
    const el = host.querySelector<HTMLElement>('[data-testid=toast]')!
    act(() => void el.dispatchEvent(ptr('pointerover')))
    act(() => void vi.advanceTimersByTime(2600))
    expect(shown()).toBe(0)
  })

  it('closes a toast when its button is pressed', () => {
    const run = vi.fn()
    act(() => post('Loaded as one object', { action: { label: 'Keep separate', run } }))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-action]')!.click())
    expect(run).toHaveBeenCalledOnce()
    expect(shown()).toBe(0)
  })
})
