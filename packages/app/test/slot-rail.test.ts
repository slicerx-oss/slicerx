// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament rail's words: a slot in plain words, the line under the rail, and why a slot carries the mismatch dot.
// Add filament: a new slot after the last one, opened for the person to pick its material and color.
import { describe, expect, it } from 'vitest'
import { addSlot, mismatchText, slotLine, slotWords, unitWords } from '../src/filament/slot-rail'
import { MAX_SLOTS, resolved } from '../src/filament/slots'
import { get, set } from '../src/state/store'

describe('filament rail words', () => {
  it('names a slot by type, family and plain color', () => {
    expect(slotWords({ type: 'PLA', family: 'Matte', brand: 'Bambu', color: '#111111' })).toBe('PLA Matte Black')
    expect(slotWords({ type: 'PETG', brand: '', color: '#fdfdfd' })).toBe('PETG White')
    // A family that repeats the type or the brand adds nothing.
    expect(slotWords({ type: 'PLA', family: 'PLA Basic', brand: 'Bambu', color: '#000000' })).toBe('PLA Black')
    expect(slotWords({ type: 'PLA', family: 'Bambu', brand: 'Bambu', color: '#000000' })).toBe('PLA Black')
  })

  it('reads the line under the rail with grams and what is left, each only when known', () => {
    expect(slotLine({ type: 'PLA', family: 'Matte', brand: '', color: '#000000' }, 96.4, '62% left')).toBe('PLA Matte Black, 96 g, 62% left')
    expect(slotLine({ type: 'PLA', brand: '', color: '#000000' }, null, null)).toBe('PLA Black')
    expect(slotLine({ type: 'PLA', brand: '', color: '#000000' }, 0, '800 g left')).toBe('PLA Black, 800 g left')
  })

  it('says what the printer holds and what the project uses', () => {
    expect(mismatchText({ slot: 2, type: 'PLA', color: '#000000', printerType: 'PETG', printerColor: '#ffffff' })).toBe('The printer has PETG White in slot 2. The project uses PLA Black.')
  })
})

describe('adding a filament from the rail', () => {
  it('adds the next slot with the defaults and opens it', () => {
    set({ slotSetup: {}, printerSlots: [], slotDialog: null })
    const before = resolved().length
    addSlot(before + 1)
    expect(resolved()).toHaveLength(before + 1)
    expect(get().slotSetup[before + 1]).toMatchObject({ type: 'PLA' })
    expect(get().slotDialog).toBe(before + 1)
  })

  it('never goes past the most a project holds', () => {
    set({ slotSetup: {}, slotDialog: null })
    addSlot(MAX_SLOTS + 1)
    expect(get().slotSetup[MAX_SLOTS + 1]).toBeUndefined()
    expect(get().slotDialog).toBeNull()
  })

  it("names the printer's filament unit that fills the slots in", () => {
    expect(unitWords('ams')).toBe("the printer's AMS")
    expect(unitWords('mmu')).toBe("the printer's MMU")
    expect(unitWords(undefined)).toBe('the printer')
  })
})
