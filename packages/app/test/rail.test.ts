// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { colorName, railGroups, slotLabel, slotMismatch, slotUsage } from '../src/filament/rail'
import type { ResolvedSlot } from '../src/filament/slots'

const slot = (index: number, label: string, extra: Partial<ResolvedSlot> = {}): ResolvedSlot => ({ index, label, type: 'PLA', brand: '', color: '#000000', source: 'printer', used: true, ...extra })

describe('grams per slot', () => {
  it('reads each slot\'s grams and share, with nothing before a slice', () => {
    expect(slotUsage({ filamentG: [30, 10] }, 3)).toEqual([{ grams: 30, share: 0.75 }, { grams: 10, share: 0.25 }, { grams: 0, share: 0 }])
    expect(slotUsage({ filamentG: [0] }, 1)).toEqual([{ grams: 0, share: 0 }])
    expect(slotUsage(null, 2)).toEqual([])
  })
})

describe('a slot the printer holds something else in', () => {
  const printer = [{ id: 'A1', material: 'PETG HF', color: 'FFFFFFFF' }, { id: 'A2', material: 'PLA Basic', color: '000000FF' }, { id: 'A3' }]

  it('flags a hand-set slot whose material or color differs', () => {
    const slots = [slot(1, 'A1', { source: 'user', type: 'PLA', color: '#000000' }), slot(2, 'A2', { source: 'user', type: 'PLA', color: '#ff0000' }), slot(3, 'A3', { source: 'user' })]
    expect(slotMismatch(printer, slots)).toEqual([
      { slot: 1, type: 'PLA', color: '#000000', printerType: 'PETG', printerColor: '#FFFFFF' },
      { slot: 2, type: 'PLA', color: '#ff0000', printerType: 'PLA', printerColor: '#000000' },
    ])
  })

  it('leaves alone slots that follow the printer, close colors, and slots the printer reports nothing for', () => {
    expect(slotMismatch(printer, [slot(1, 'A1'), slot(2, 'A2', { source: 'user', color: '#0a0a0a' }), slot(3, 'A3', { source: 'user' })])).toEqual([])
    expect(slotMismatch([], [slot(1, '1', { source: 'user' })])).toEqual([])
  })
})

describe('the rail\'s groups', () => {
  it('groups AMS units and the external spool, in order', () => {
    const groups = railGroups([slot(1, 'A1'), slot(2, 'A2'), slot(3, 'B1'), slot(4, 'Ext')])
    expect(groups.map((g) => [g.unit, g.slots.map((s) => s.label)])).toEqual([
      ['AMS 1', ['A1', 'A2']],
      ['AMS 2', ['B1']],
      ['External', ['Ext']],
    ])
  })

  it('is one group of plain slots without a printer', () => {
    expect(railGroups([slot(1, '1'), slot(2, '2')]).map((g) => g.unit)).toEqual(['Slots'])
  })
})

describe('slot labels', () => {
  it('names colors plainly', () => {
    expect(colorName('#050505')).toBe('Black')
    expect(colorName('#fafafa')).toBe('White')
    expect(colorName('#d40000')).toBe('Red')
    expect(colorName('not a color')).toBe('Black')
    expect(slotLabel({ label: 'A2', type: 'PETG', color: '#ffffff' })).toBe('A2 PETG White')
  })
})
