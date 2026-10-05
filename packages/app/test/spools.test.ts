// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { filterSpools, parseSpools, shortfalls, spoolFor, spoolVendors, type Spool } from '../src/inventory/spools'

const spool = (id: number, remainingG: number): Spool => ({ id, material: 'PLA', vendor: 'Acme', name: `Red ${id}`, color: '#ff0000', remainingG, initialG: 1000 })

describe('spool inventory', () => {
  it('keeps well-formed spools and drops the rest', () => {
    const list = parseSpools([{ id: 1, material: 'PETG', vendor: 'A', name: 'B', color: '#00ff00', remainingG: 420.5, initialG: 1000 }, { id: 'x' }, null, { id: 2, remainingG: -5 }])
    expect(list.map((s) => s.id)).toEqual([1, 2])
    expect(list[1]!.remainingG).toBe(0)
    expect(parseSpools({ spools: [{ id: 3, remainingG: 1 }] })).toHaveLength(1)
    expect(parseSpools('nope')).toEqual([])
  })

  it('the person\'s link wins over what the printer reports', () => {
    const spools = [spool(1, 500), spool(2, 300)]
    expect(spoolFor(1, spools, {}, 2)?.id).toBe(2)
    expect(spoolFor(1, spools, { 1: 1 }, 2)?.id).toBe(1)
    expect(spoolFor(1, spools, {}, undefined)).toBeUndefined()
    expect(spoolFor(1, spools, { 1: 99 })).toBeUndefined()
  })

  it('names the slots whose spool holds less than the plate needs', () => {
    const spools = [spool(1, 40), spool(2, 500)]
    const of = (slot: number) => spools[slot - 1]
    const s = shortfalls([55, 20, 10], of)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ slot: 1, needG: 55, haveG: 40 })
  })
})

describe('spool filters', () => {
  const list: Spool[] = [
    { id: 1, material: 'PLA', vendor: 'Acme', name: 'Red', color: '#ff0000', remainingG: 500, initialG: 1000 },
    { id: 2, material: 'PETG', vendor: 'Zeta', name: 'Blue', color: '#0000ff', remainingG: 300, initialG: 1000 },
    { id: 3, material: 'PLA', vendor: 'Acme', name: 'Blue', color: '#0000ee', remainingG: 100, initialG: 1000 },
    { id: 4, material: 'PLA', vendor: '', name: 'Plain', color: '#888888', remainingG: 100, initialG: 1000 },
  ]

  it('lists each vendor once, sorted, without the blank one', () => {
    expect(spoolVendors(list)).toEqual(['Acme', 'Zeta'])
  })

  it('narrows by vendor and by words in the name or material', () => {
    expect(filterSpools(list, '').map((s) => s.id)).toEqual([1, 2, 3, 4])
    expect(filterSpools(list, 'Acme').map((s) => s.id)).toEqual([1, 3])
    expect(filterSpools(list, 'Acme', 'blue').map((s) => s.id)).toEqual([3])
    expect(filterSpools(list, '', 'petg zeta').map((s) => s.id)).toEqual([2])
    expect(filterSpools(list, 'Zeta', 'red')).toEqual([])
  })
})
