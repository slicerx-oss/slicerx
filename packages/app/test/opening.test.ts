// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window's opening: the static frame fades once the app is ready under it, and toasts wait for the opening to end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootDone, whenAppReady } from '../src/shell/boot'
import { get, holdToasts, set, toast } from '../src/state/store'

afterEach(() => {
  vi.useRealTimers()
  delete document.documentElement.dataset['sxReady']
  document.getElementById('sx-boot')?.remove()
})

describe('the opening frame', () => {
  it('fades and goes once asked, once', () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    el.id = 'sx-boot'
    document.body.append(el)
    bootDone()
    expect(el.dataset['leaving']).toBe('1')
    bootDone()
    vi.advanceTimersByTime(300)
    expect(document.getElementById('sx-boot')).toBeNull()
  })

  it('waits for the plate and its view, another workspace, or the time limit', async () => {
    const ready = vi.fn()
    whenAppReady(ready, () => false)
    expect(ready).not.toHaveBeenCalled()
    document.documentElement.dataset['sxReady'] = 'plate'
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    document.documentElement.dataset['sxReady'] = 'viewport'
    await new Promise((r) => setTimeout(r, 0))
    expect(ready).toHaveBeenCalledTimes(1)

    const other = vi.fn()
    whenAppReady(other, () => true)
    expect(other).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    delete document.documentElement.dataset['sxReady']
    const late = vi.fn()
    whenAppReady(late, () => false, 4000)
    vi.advanceTimersByTime(3999)
    expect(late).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(late).toHaveBeenCalledTimes(1)
  })
})

describe('toasts during the opening', () => {
  it('are held while it covers the app and shown one after another when it ends', () => {
    vi.useFakeTimers()
    set({ toast: null })
    holdToasts(true)
    toast('Connected to the printer bridge', 'ok')
    toast('Second note')
    expect(get().toast).toBeNull()
    holdToasts(false)
    vi.advanceTimersByTime(0)
    expect(get().toast?.text).toBe('Connected to the printer bridge')
    vi.advanceTimersByTime(1200)
    expect(get().toast?.text).toBe('Second note')
    // Not held any more: a toast shows at once.
    toast('Now')
    expect(get().toast?.text).toBe('Now')
  })
})
