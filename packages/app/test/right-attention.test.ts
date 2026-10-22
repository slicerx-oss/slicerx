// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What makes Slice's shut right pane glow, and the names that buttons cut in the middle.
import type { PrinterState, SliceResult } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { attentionKey, printResultKey } from '../src/lib/right-attention'
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

  it('keys a finished print on when it ended, so status events after it do not bring the glow back', () => {
    const at = (state: PrinterState, updatedAt: string, jobName = 'cube', bed = 60) => ({ id: 'bay-9', status: { printerId: 'bay-9', state, jobName, updatedAt, nozzles: [], bed: { current: bed, target: 0 }, slots: [], cameraAvailable: true } })
    expect(printResultKey(at('printing', 't0'))).toBeNull()
    const ended = printResultKey(at('finished', 't1'))
    expect(ended).not.toBeNull()
    // The bed and nozzles cool after the job: each step is a new status with a new updatedAt, and the same print.
    expect(printResultKey(at('finished', 't2', 'cube', 55))).toBe(ended)
    expect(printResultKey(at('finished', 't3', 'cube', 40))).toBe(ended)
    // A printer that drops off and comes back still Finished is the same print.
    expect(printResultKey(at('offline', 't4'))).toBeNull()
    expect(printResultKey(at('finished', 't5', 'cube', 30))).toBe(ended)
    // The next job that ends wants a look again.
    expect(printResultKey(at('printing', 't6', 'gear'))).toBeNull()
    const next = printResultKey(at('finished', 't7', 'gear'))
    expect(next).not.toBeNull()
    expect(next).not.toBe(ended)
    // A job that fails right after another finished, with no printing status seen between them, is a new result.
    expect(printResultKey(at('error', 't8', 'gear'))).not.toBe(next)
    expect(printResultKey(undefined)).toBeNull()
  })

  it('starts shut, and reads open once opened (by the person or a finished slice)', () => {
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
