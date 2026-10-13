// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Code that failed to download is fetched again by one reload, never with unsaved work and never twice in a row.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, noteWorkspaceDown, noteWorkspaceUp, onChunkError, reloadForChunk, resetChunkNotice } from '../src/lib/chunk-reload'
import { toast } from '../src/state/store'

vi.mock('../src/state/store', async (original) => ({ ...(await original<object>()), toast: vi.fn() }))
vi.mock('../src/project/unsaved', () => ({ isDirty: () => true }))

describe('a part of the app that did not download', () => {
  beforeEach(() => sessionStorage.clear())

  it('is told apart from other errors, in each browser wording', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:4317/studio/static/dock-CQAm4HOD.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/studio-1.js'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /static/app.css'))).toBe(true)
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })

  it('reloads once, and not again within half a minute', () => {
    const reload = vi.fn()
    expect(reloadForChunk(1_000_000, false, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reloadForChunk(1_010_000, false, reload)).toBe(false)
    expect(reloadForChunk(1_031_000, false, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('never reloads over unsaved work', () => {
    const reload = vi.fn()
    expect(reloadForChunk(1_000_000, true, reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

// Unsaved work (mocked above) keeps the app from reloading, so each failure goes to the message.
describe('the message for code that did not download', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(toast).mockClear()
    resetChunkNotice()
  })

  it('waits for a workspace still loading, however slow, and stays away when it fails with the same download', () => {
    onChunkError()
    vi.advanceTimersByTime(2_000)
    noteWorkspaceDown()
    vi.advanceTimersByTime(20_000)
    expect(toast).not.toHaveBeenCalled()
  })

  it('shows once the workspace is up, and only once', () => {
    onChunkError()
    vi.advanceTimersByTime(2_000)
    expect(toast).not.toHaveBeenCalled()
    noteWorkspaceUp()
    vi.advanceTimersByTime(400)
    onChunkError()
    vi.advanceTimersByTime(20_000)
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('shows after a while when the workspace neither comes up nor fails', () => {
    onChunkError()
    vi.advanceTimersByTime(10_000)
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
