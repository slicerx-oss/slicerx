// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A toast's time starts on its first frame, not when it is posted, and lasts as long as its text takes to read. Any
// toast waits while it is hovered or focused and runs on with the time it had left.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readingTime, ToastClock, ToastProvider, useToast, type ToastOptions } from '../src/components/toast'

const NOZZLE_NOTE = "Slicing for the A1 mini with its own G-code. Not carried over, made for the project's 0.2 mm nozzle: layer height."

describe("a toast's reading time", () => {
  it('is 2.6 s for a short note, and 60 ms more for each character past 40', () => {
    expect(readingTime('Saved')).toBe(2600)
    expect(readingTime('x'.repeat(40))).toBe(2600)
    expect(readingTime('x'.repeat(41))).toBe(2660)
    expect(readingTime(NOZZLE_NOTE)).toBe(2600 + (NOZZLE_NOTE.length - 40) * 60)
    // The long nozzle note stays up long enough to read: about 7 s.
    expect(readingTime(NOZZLE_NOTE)).toBeGreaterThan(6500)
  })

  it('gives a warning or an error at least 6 s, and keeps a longer time a caller asks for', () => {
    expect(readingTime('Check the bed', 'warn')).toBe(6000)
    expect(readingTime('Could not save', 'error')).toBe(6000)
    expect(readingTime(NOZZLE_NOTE, 'warn')).toBe(readingTime(NOZZLE_NOTE))
    expect(readingTime('Saved', 'plain', 8000)).toBe(8000)
    expect(readingTime(NOZZLE_NOTE, 'plain', 1000)).toBe(readingTime(NOZZLE_NOTE))
  })

  it('reads the text inside elements', () => {
    expect(readingTime(<span>{'x'.repeat(30)}<b>{'y'.repeat(30)}</b></span>)).toBe(2600 + 20 * 60)
  })
})

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

  it('starts held until it is drawn, then runs its whole time', () => {
    const done = vi.fn()
    const c = new ToastClock(1000, done, ['unseen'])
    vi.advanceTimersByTime(5000)
    expect(done).not.toHaveBeenCalled()
    c.release('unseen')
    vi.advanceTimersByTime(999)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledOnce()
  })

  it('a toast hovered before it is drawn waits for both, then runs its whole time', () => {
    const done = vi.fn()
    const c = new ToastClock(1000, done, ['unseen'])
    c.hold('pointer')
    c.release('unseen')
    vi.advanceTimersByTime(5000)
    expect(done).not.toHaveBeenCalled()
    c.release('pointer')
    vi.advanceTimersByTime(999)
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

  it('lets a plain toast go on time after its first frame', () => {
    act(() => post('Saved'))
    // The first frame starts its time.
    act(() => void vi.advanceTimersByTime(20))
    act(() => void vi.advanceTimersByTime(2580))
    expect(shown()).toBe(1)
    act(() => void vi.advanceTimersByTime(20))
    expect(shown()).toBe(0)
  })

  it('keeps a plain toast while hovered, then runs on with its time left', () => {
    act(() => post('Saved'))
    const el = host.querySelector<HTMLElement>('[data-testid=toast]')!
    act(() => void vi.advanceTimersByTime(20))
    act(() => void vi.advanceTimersByTime(1000))
    act(() => void el.dispatchEvent(ptr('pointerover')))
    act(() => void vi.advanceTimersByTime(30_000))
    expect(shown()).toBe(1)
    act(() => void el.dispatchEvent(ptr('pointerout')))
    act(() => void vi.advanceTimersByTime(1500))
    expect(shown()).toBe(1)
    act(() => void vi.advanceTimersByTime(200))
    expect(shown()).toBe(0)
  })

  it('keeps the long nozzle note up for its reading time', () => {
    act(() => post(NOZZLE_NOTE))
    act(() => void vi.advanceTimersByTime(20))
    act(() => void vi.advanceTimersByTime(readingTime(NOZZLE_NOTE) - 100))
    expect(shown()).toBe(1)
    act(() => void vi.advanceTimersByTime(200))
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
