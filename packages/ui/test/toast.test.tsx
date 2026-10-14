// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A toast's time starts on its first frame, not when it is posted, and lasts as long as its text takes to read. Any
// toast waits while it is hovered or focused and runs on with the time it had left.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterTime, fitCard, readingTime, splitLead, staysUntilDismissed, ToastClock, ToastProvider, useHideToasts, useToast, type ToastOptions } from '../src/components/toast'

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

  it('keeps one time for the card: the lines go together, after the longest one takes to read', () => {
    act(() => post('Saved'))
    act(() => post(NOZZLE_NOTE))
    expect(host.querySelectorAll('.sx-toasts').length).toBe(1)
    act(() => void vi.advanceTimersByTime(20))
    act(() => void vi.advanceTimersByTime(2600))
    expect(shown()).toBe(2)
    act(() => void vi.advanceTimersByTime(readingTime(NOZZLE_NOTE) - 2600))
    expect(shown()).toBe(0)
  })

  it('waits while the pointer is anywhere on the card, on its way to Details or a button', () => {
    act(() => post('Saved'))
    act(() => post(NOZZLE_NOTE, { action: { label: 'Change printer', run: () => {} } }))
    act(() => void vi.advanceTimersByTime(20))
    const stack = host.querySelector<HTMLElement>('[data-testid=toasts]')!
    act(() => void stack.dispatchEvent(ptr('pointerover')))
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown()).toBe(2)
    act(() => void stack.dispatchEvent(new ((globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent)('pointerout', { bubbles: true, relatedTarget: document.body })))
    act(() => void vi.advanceTimersByTime(readingTime(NOZZLE_NOTE)))
    expect(shown()).toBe(0)
  })

  it('waits while keyboard focus is anywhere in the card, and runs on once it leaves', () => {
    act(() => post('Saved'))
    act(() => post(NOZZLE_NOTE, { action: { label: 'Change printer', run: () => {} } }))
    act(() => void vi.advanceTimersByTime(20))
    const outside = document.createElement('button')
    document.body.append(outside)
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-details]')!.focus())
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown()).toBe(2)
    // Moving between the card's own buttons keeps it.
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-action]')!.focus())
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown()).toBe(2)
    act(() => outside.focus())
    act(() => void vi.advanceTimersByTime(readingTime(NOZZLE_NOTE)))
    expect(shown()).toBe(0)
    outside.remove()
  })

  it('shows the first sentence, and Details opens the rest in place with the card top held', () => {
    act(() => post(NOZZLE_NOTE))
    const stack = host.querySelector<HTMLElement>('[data-testid=toasts]')!
    const line = host.querySelector<HTMLElement>('[data-testid=toast]')!
    expect(line.querySelector('.sx-toast-lead')!.textContent).toBe('Slicing for the A1 mini with its own G-code.')
    expect(line.hasAttribute('data-expanded')).toBe(false)
    expect(stack.style.top).toBe('')
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-details]')!.click())
    expect(line.hasAttribute('data-expanded')).toBe(true)
    expect(host.querySelector('[data-testid=toast-details]')!.getAttribute('aria-label')).toBe('Less')
    // The label is drawn, not text, so the toast's text stays its message.
    expect(line.textContent).toBe(NOZZLE_NOTE)
    expect(stack.style.top).toBe('0px')
    expect(stack.style.bottom).toBe('auto')
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-details]')!.click())
    expect(line.hasAttribute('data-expanded')).toBe(false)
    expect(stack.style.top).toBe('')
  })

  it('has no Details on a one sentence toast', () => {
    act(() => post('Saved.'))
    expect(host.querySelector('[data-testid=toast-details]')).toBeNull()
  })

  it('closes a toast when its button is pressed', () => {
    const run = vi.fn()
    act(() => post('Loaded as one object', { action: { label: 'Keep separate', run } }))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid=toast-action]')!.click())
    expect(run).toHaveBeenCalledOnce()
    expect(shown()).toBe(0)
  })

  describe('a warning', () => {
    const lines = () => [...host.querySelectorAll('[data-testid=toast]')].map((l) => l.querySelector('.sx-toast-lead')!.textContent)
    const dismiss = (n = 0) => host.querySelectorAll<HTMLButtonElement>('[data-testid=toast-dismiss]')[n]!.click()

    it('stays on the card after the time that clears information, with a way to dismiss it', () => {
      act(() => post('Saved'))
      act(() => post('The bed is smaller than the plate.', { tone: 'warn' }))
      act(() => void vi.advanceTimersByTime(20))
      expect(shown()).toBe(2)
      // Far past the longest reading time on the card.
      act(() => void vi.advanceTimersByTime(60_000))
      expect(lines()).toEqual(['The bed is smaller than the plate.'])
      expect(host.querySelectorAll('[data-testid=toast-dismiss]').length).toBe(1)
      act(() => void vi.advanceTimersByTime(10 * 60_000))
      expect(shown()).toBe(1)
    })

    it('stays when it is alone on the card, and when information joins later and goes', () => {
      act(() => post('Check the nozzle.', { tone: 'warn' }))
      act(() => void vi.advanceTimersByTime(60_000))
      expect(shown()).toBe(1)
      act(() => post('Saved'))
      act(() => void vi.advanceTimersByTime(20))
      expect(shown()).toBe(2)
      act(() => void vi.advanceTimersByTime(2600))
      expect(lines()).toEqual(['Check the nozzle.'])
    })

    it('is removed by its dismiss button and by nothing else, leaving information to its time', () => {
      act(() => post('Check the nozzle.', { tone: 'warn' }))
      act(() => post('Saved'))
      act(() => void vi.advanceTimersByTime(20))
      // Information has no dismiss button.
      expect(host.querySelectorAll('[data-testid=toast-dismiss]').length).toBe(1)
      act(() => dismiss())
      expect(lines()).toEqual(['Saved'])
      act(() => void vi.advanceTimersByTime(2600))
      expect(shown()).toBe(0)
    })

    it('does not start the card\'s time or lengthen it', () => {
      act(() => post('Saved'))
      act(() => void vi.advanceTimersByTime(20))
      act(() => post('x'.repeat(400), { tone: 'warn' }))
      // The warning would have read for 24 s; the card still ends on the information\'s own time.
      act(() => void vi.advanceTimersByTime(2600))
      expect(shown()).toBe(1)
      expect(host.querySelector('[data-tone=warn]')).not.toBeNull()
    })

    it('keeps the card\'s time paused while hovered, with the warning still there after', () => {
      act(() => post('Saved'))
      act(() => post('Check the nozzle.', { tone: 'warn' }))
      const stack = host.querySelector<HTMLElement>('[data-testid=toasts]')!
      act(() => void vi.advanceTimersByTime(20))
      act(() => void stack.dispatchEvent(ptr('pointerover')))
      act(() => void vi.advanceTimersByTime(60_000))
      expect(shown()).toBe(2)
      act(() => void stack.dispatchEvent(ptr('pointerout')))
      act(() => void vi.advanceTimersByTime(2600))
      expect(lines()).toEqual(['Check the nozzle.'])
    })

    it('can be asked to stay, and a warning can be asked not to', () => {
      act(() => post('Saved to the vault', { persist: true }))
      act(() => post('Heads up.', { tone: 'warn', persist: false }))
      act(() => void vi.advanceTimersByTime(20))
      act(() => void vi.advanceTimersByTime(60_000))
      expect(lines()).toEqual(['Saved to the vault'])
    })

    it('is not pushed off a full card by newer information', () => {
      act(() => post('Check the nozzle.', { tone: 'warn' }))
      for (const t of ['One', 'Two', 'Three', 'Four']) act(() => post(t))
      expect(lines()).toEqual(['Check the nozzle.', 'Three', 'Four'])
    })
  })
})

describe('toasts and the view under them', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8')
  const rule = (selector: string) => css.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? ''

  it('lets a press through the empty stack, so the 3D view takes it when no toast is up', () => {
    expect(rule('.sx-toasts')).toContain('pointer-events: none')
  })

  it('has the card take the pointer while a toast is up, so hovering it holds its time', () => {
    expect(rule('.sx-toasts:not(:empty)')).toContain('pointer-events: auto')
  })

  it('keeps a toast own buttons and links pressable', () => {
    expect(rule('.sx-toast button, .sx-toast a')).toContain('pointer-events: auto')
  })
})

describe('which lines stay', () => {
  const l = (name: string, persist: boolean) => ({ name, persist })
  it('stays for a warning and for a line that asks, and for no other tone', () => {
    expect(staysUntilDismissed('warn')).toBe(true)
    for (const tone of ['plain', 'ok', 'info', 'error'] as const) expect(staysUntilDismissed(tone)).toBe(false)
    expect(staysUntilDismissed('info', true)).toBe(true)
    expect(staysUntilDismissed('warn', false)).toBe(false)
  })

  it('keeps only the persistent lines when the card\'s time ends', () => {
    expect(afterTime([l('a', false), l('b', true), l('c', false)]).map((t) => t.name)).toEqual(['b'])
    expect(afterTime([l('a', false)])).toEqual([])
  })

  it('drops the oldest information first to fit a full card, and a warning only when nothing else is left', () => {
    expect(fitCard([l('w', true), l('a', false), l('b', false), l('c', false)], 3).map((t) => t.name)).toEqual(['w', 'b', 'c'])
    expect(fitCard([l('w1', true), l('w2', true), l('w3', true), l('w4', true)], 3).map((t) => t.name)).toEqual(['w2', 'w3', 'w4'])
    expect(fitCard([l('a', false)], 3)).toHaveLength(1)
  })
})

describe('the card\'s look', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8')
  const rule = (selector: string) => css.split('\n').find((x) => x.startsWith(`${selector} {`)) ?? ''
  it('has 16 px padding and the lift tokens, floating', () => {
    const card = rule('.sx-toasts:not(:empty)')
    expect(card).toContain('padding: var(--s-4)')
    expect(card).toContain('var(--shadow-float)')
    expect(card).toContain('var(--lift-edge)')
    expect(css).toMatch(/\.sx-toasts:not\(:empty\)[^{]*\{[^}]*\}[\s\S]*\.sx-toasts:not\(:empty\), \.sx-rail\[data-peek\] \{[^}]*--lift-glass/)
  })
  it('wraps a note to two lines before Details takes over', () => {
    const text = rule('.sx-toast-text')
    expect(text).toContain('-webkit-line-clamp: 2')
    expect(text).not.toContain('nowrap')
  })
})

describe('a toast line', () => {
  it('splits a message after its first sentence, keeping numbers like 0.4 whole', () => {
    expect(splitLead('Opened as H2D 0.4 mm from the project. Kept the walls.')).toEqual({ lead: 'Opened as H2D 0.4 mm from the project.', rest: 'Kept the walls.' })
    expect(splitLead('Saved')).toEqual({ lead: 'Saved', rest: '' })
    expect(splitLead('Saved.')).toEqual({ lead: 'Saved.', rest: '' })
  })
})

describe('toasts held out of sight', () => {
  let host: HTMLDivElement
  let root: Root
  let post: (text: string, options?: ToastOptions) => void = () => {}
  function App({ hidden }: { hidden: boolean }) {
    const toast = useToast()
    useHideToasts(hidden, 'grid')
    useEffect(() => void (post = toast), [toast])
    return null
  }
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })
  const stack = () => host.querySelector<HTMLElement>('[data-testid=toasts]')!
  const shown = () => host.querySelectorAll('[data-testid=toast]').length

  it('hides the card with its time stopped, and brings it back with the time it had left', () => {
    act(() => root.render(<ToastProvider><App hidden={false} /></ToastProvider>))
    act(() => post('Saved'))
    act(() => void vi.advanceTimersByTime(20))
    act(() => void vi.advanceTimersByTime(1000))
    act(() => root.render(<ToastProvider><App hidden /></ToastProvider>))
    expect(stack().hasAttribute('data-held')).toBe(true)
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown()).toBe(1)
    act(() => root.render(<ToastProvider><App hidden={false} /></ToastProvider>))
    expect(stack().hasAttribute('data-held')).toBe(false)
    act(() => void vi.advanceTimersByTime(1500))
    expect(shown()).toBe(1)
    act(() => void vi.advanceTimersByTime(200))
    expect(shown()).toBe(0)
  })

  it('holds a toast posted while hidden until the card shows again', () => {
    act(() => root.render(<ToastProvider><App hidden /></ToastProvider>))
    act(() => post('Saved'))
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown()).toBe(1)
    act(() => root.render(<ToastProvider><App hidden={false} /></ToastProvider>))
    act(() => void vi.advanceTimersByTime(2700))
    expect(shown()).toBe(0)
  })
})
