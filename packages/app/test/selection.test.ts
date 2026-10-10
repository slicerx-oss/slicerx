// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { clearSelection, selectObject } from '../src/plate/edit'
import { rangeSelect, selectByFilament, selectionSummary } from '../src/plate/selection'
import { appStore, get, selectedIds, type PlateEntry } from '../src/state/store'

const order = ['a', 'b', 'c', 'd']

describe('a Shift range in the object list', () => {
  it('runs from the anchor to the target either way, both included', () => {
    expect(rangeSelect(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelect(order, 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(rangeSelect(order, 'c', 'c')).toEqual(['c'])
  })

  it('selects the target alone without an anchor, or when the anchor left the plate', () => {
    expect(rangeSelect(order, null, 'c')).toEqual(['c'])
    expect(rangeSelect(order, 'gone', 'c')).toEqual(['c'])
    expect(rangeSelect(order, 'a', 'gone')).toEqual([])
  })
})

describe('selecting by filament', () => {
  const part = (name: string, slot: number) => ({ name, slot }) as never
  const plate = [
    { id: 'a', parts: [part('body', 1), part('logo', 2)] },
    { id: 'b', parts: [part('body', 1)], slotOverrides: { body: 3 } },
    { id: 'c', parts: [part('body', 2)] },
  ] as never[]

  it('finds every object with a part on the slot, picked filaments included', () => {
    expect(selectByFilament(plate, 2)).toEqual(['a', 'c'])
    expect(selectByFilament(plate, 1)).toEqual(['a'])
    expect(selectByFilament(plate, 3)).toEqual(['b'])
    expect(selectByFilament(plate, 4)).toEqual([])
    expect(selectByFilament([], 1)).toEqual([])
  })
})

describe('what a selection holds', () => {
  const plate = [
    { id: 'a', name: 'Benchy', locked: true },
    { id: 'b', name: 'Clip', locked: true, printable: false },
    { id: 'c', name: 'Lid' },
  ]

  it('counts, names and reads the shared toggles', () => {
    expect(selectionSummary(plate, ['a', 'b'])).toEqual({ count: 2, names: ['Benchy', 'Clip'], allLocked: true, allSkipped: false })
    expect(selectionSummary(plate, ['b'])).toMatchObject({ allLocked: true, allSkipped: true })
    expect(selectionSummary(plate, [])).toEqual({ count: 0, names: [], allLocked: false, allSkipped: false })
  })
})

describe('clicks in the object list', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  beforeEach(() => appStore.setState({ plate: ids.map((id) => ({ id, name: id }) as PlateEntry), selection: null, selectedIds: [] }))
  const picked = () => selectedIds(get())

  it('selects a Shift range from the last plain or Mod click, and keeps that anchor for the next range', () => {
    selectObject('b', 'set')
    selectObject('d', 'range')
    expect(picked()).toEqual(['b', 'c', 'd'])
    selectObject('a', 'range')
    expect(picked()).toEqual(['a', 'b'])
    selectObject('e', 'toggle')
    selectObject('c', 'range')
    expect(picked()).toEqual(['c', 'd', 'e'])
  })

  it('starts a range at the primary when the selection came from elsewhere', () => {
    selectObject('a', 'set')
    appStore.setState({ selection: 'd', selectedIds: ['d'] })
    selectObject('b', 'range')
    expect(picked()).toEqual(['b', 'c', 'd'])
  })

  it('Mod toggles, true and false still mean toggle and set, and clear empties it', () => {
    selectObject('a', false)
    selectObject('c', true)
    expect(picked()).toEqual(['a', 'c'])
    selectObject('a', 'toggle')
    expect(picked()).toEqual(['c'])
    clearSelection()
    expect(get().selection).toBeNull()
    expect(picked()).toEqual([])
  })
})
