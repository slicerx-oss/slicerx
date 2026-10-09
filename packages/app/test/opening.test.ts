// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window's opening: the static frame fades once the app is ready under it, and toasts wait for the opening to end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootDone, whenShellReady, whenViewReady } from '../src/shell/boot'
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

  it('fades once Slice has mounted or another workspace opened, at the latest after the limit', async () => {
    const ready = vi.fn()
    whenShellReady(ready, () => false)
    expect(ready).not.toHaveBeenCalled()
    const studio = document.createElement('div')
    studio.className = 'studio'
    document.body.append(studio)
    await new Promise((r) => setTimeout(r, 0))
    expect(ready).toHaveBeenCalledTimes(1)
    studio.remove()

    const other = vi.fn()
    whenShellReady(other, () => true)
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('holds the 3D view until it is up, at most 1.5 s', async () => {
    const up = vi.fn()
    whenViewReady(up)
    document.documentElement.dataset['sxReady'] = 'plate'
    await new Promise((r) => setTimeout(r, 0))
    expect(up).not.toHaveBeenCalled()
    document.documentElement.dataset['sxReady'] = 'viewport'
    await new Promise((r) => setTimeout(r, 0))
    expect(up).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    delete document.documentElement.dataset['sxReady']
    const late = vi.fn()
    whenViewReady(late)
    vi.advanceTimersByTime(1499)
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
