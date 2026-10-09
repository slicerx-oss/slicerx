// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What makes Slice's shut right pane glow, and the names that buttons cut in the middle.
import type { SliceResult } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { attentionKey } from '../src/lib/right-attention'
import { shortPrinterName, splitForMiddle } from '../src/lib/short-name'
import { railOpen, type AppState } from '../src/state/store'

const result = (warnings: number) => ({ id: `r${warnings}`, stats: { timeS: 60, filamentG: [1], filamentMm: [], cost: 0, toolChanges: 0 }, warnings: Array.from({ length: warnings }, () => ({ code: 'thin_wall', message: 'Thin' })) }) as unknown as SliceResult
const base = { plate: [], bed: { widthMm: 256, depthMm: 256 }, printerSlots: [] } as unknown as Pick<AppState, 'slice' | 'plate' | 'bed' | 'printerSlots'>

describe('the right pane glow', () => {
  it('stays calm for a clean slice and for nothing at all', () => {
    expect(attentionKey({ ...base, slice: { status: 'idle' } }, [], null)).toBeNull()
    expect(attentionKey({ ...base, slice: { status: 'done', result: result(0), stale: false } }, [], null)).toBeNull()
  })

  it('wants a look for a slice with warnings, a fit note and a print that finished or failed', () => {
    expect(attentionKey({ ...base, slice: { status: 'done', result: result(2), stale: false } }, [], null)).toBe('slice:r2')
    // A stale slice's warnings are old news until it slices again.
    expect(attentionKey({ ...base, slice: { status: 'done', result: result(2), stale: true } }, [], null)).toBeNull()
    expect(attentionKey({ ...base, slice: { status: 'idle' } }, ['b', 'a'], null)).toBe('fit:a,b')
    expect(attentionKey({ ...base, slice: { status: 'idle' } }, [], 'bay-1:finished:t')).toBe('print:bay-1:finished:t')
  })

  it('starts shut: the pane opens only when the person opens it, and then stays as they left it', () => {
    expect(railOpen({}, 'preview', 'right', true)).toBe(false)
    expect(railOpen({ preview: { right: true } }, 'preview', 'right', true)).toBe(true)
    // Other panes keep their own rule.
    expect(railOpen({}, 'prepare', 'left', true)).toBe(true)
  })
})

describe('names in buttons', () => {
  it('drops a project printer\'s "from <project>" for display', () => {
    expect(shortPrinterName('H2D 0.4 from CHAINSAW_MAN_-_POCHITA_-_KEYCHAIN')).toBe('H2D 0.4')
    expect(shortPrinterName('Desk A1')).toBe('Desk A1')
  })

  it('cuts a long file name in the middle and keeps its extension', () => {
    const [head, tail] = splitForMiddle(`${'a'.repeat(110)}_final.stl`)
    expect(tail.endsWith('.stl')).toBe(true)
    expect(head + tail).toBe(`${'a'.repeat(110)}_final.stl`)
    expect(splitForMiddle('Benchy')).toEqual(['', 'Benchy'])
  })
})
