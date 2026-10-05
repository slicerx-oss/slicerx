// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { dueItems, isDue, startable, startAfterFromLocal, type QueueItem } from '../src/queue/queue'

const item = (id: string, printerId: string, startAfter?: string): QueueItem => ({
  id,
  printerId,
  printerName: printerId,
  plateName: id,
  remote: { printerId, path: `/${id}.gcode`, name: `${id}.gcode` },
  sha256: 'ab',
  layers: 10,
  timeS: 600,
  grams: 5,
  options: {},
  ...(startAfter ? { startAfter } : {}),
  addedAt: '2026-09-30T10:00:00.000Z',
})

describe('print queue', () => {
  it('an item is due once its time has passed; one without a time is never due', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    expect(isDue(item('a', 'p1', '2026-09-30T11:59:00Z'), now)).toBe(true)
    expect(isDue(item('b', 'p1', '2026-09-30T12:01:00Z'), now)).toBe(false)
    expect(isDue(item('c', 'p1'), now)).toBe(false)
    expect(dueItems([item('a', 'p1', '2026-09-30T11:00:00Z'), item('b', 'p1')], now).map((q) => q.id)).toEqual(['a'])
  })

  it('runs in order on one printer and in parallel across printers', () => {
    const q = [item('a', 'p1'), item('b', 'p1'), item('c', 'p2')]
    expect([...startable(q)]).toEqual(['a', 'c'])
  })

  it('reads a local date and time, and ignores an empty or bad one', () => {
    expect(startAfterFromLocal('')).toBeUndefined()
    expect(startAfterFromLocal('not a date')).toBeUndefined()
    expect(Date.parse(startAfterFromLocal('2026-10-01T02:00')!)).toBe(new Date('2026-10-01T02:00').getTime())
  })
})
