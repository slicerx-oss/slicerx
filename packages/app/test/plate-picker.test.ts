// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate picker's logic: names cut in the middle to fit, stepping through the plates and stopping at the ends, the
// sheet's search and Not sliced filter, each plate's slice state, and the Shift+[ and Shift+] keys.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEYMAPS, keymapConflicts, LOOK_IDS } from '@slicerx/ui'
import { fitMiddle, midTruncate } from '../src/lib/mid-truncate'
import { matchShortcut } from '../src/lib/keys'
import { filterPlates, findPlate, plateRows, plateSubtitle, sliceStateOf, stepPlate, stepTarget, type PlateRow } from '../src/plate/plate-step'
import { get, set } from '../src/state/store'

describe('middle truncation', () => {
  it('keeps a name that fits, and cuts a long one in the middle with the end kept', () => {
    expect(midTruncate('Lid', 10)).toBe('Lid')
    expect(midTruncate('Deck box, label plate, racer', 28)).toBe('Deck box, label plate, racer')
    const cut = midTruncate('Retro console deck box, label plate, kart racer', 21)
    expect(cut).toHaveLength(21)
    expect(cut.startsWith('Retro cons')).toBe(true)
    expect(cut.endsWith('kart racer')).toBe(true)
    expect(cut).toContain('…')
  })

  it('never leaves a space beside the ellipsis, and handles the smallest sizes', () => {
    expect(midTruncate('Shell, front half', 8)).not.toMatch(/ …|… /)
    expect(midTruncate('abcdef', 1)).toBe('…')
    expect(midTruncate('abcdef', 0)).toBe('')
    expect(midTruncate('abcdef', 2)).toBe('…f')
  })

  it('names that differ only at the end stay different after the cut', () => {
    const a = midTruncate('Retro console deck box, label plate, starship', 24)
    const b = midTruncate('Retro console deck box, label plate, kart racer', 24)
    expect(a).not.toBe(b)
  })

  it('fits the widest cut into a width, measured in px', () => {
    const measure = (t: string) => t.length * 7
    expect(fitMiddle('Short', 100, measure)).toBe('Short')
    const fit = fitMiddle('Retro console deck box, label plate, kart racer', 140, measure)
    expect(fit.length * 7).toBeLessThanOrEqual(140)
    expect((fit.length + 1) * 7).toBeGreaterThan(140)
    expect(fit.endsWith('racer')).toBe(true)
    expect(fitMiddle('Anything', 3, measure)).toBe('')
  })
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` }))

describe('stepping through plates', () => {
  it('steps one plate either way and stops at the first and the last', () => {
    expect(stepTarget(ids(3), 'p2', 1)).toBe('p3')
    expect(stepTarget(ids(3), 'p2', -1)).toBe('p1')
    expect(stepTarget(ids(3), 'p3', 1)).toBeNull()
    expect(stepTarget(ids(3), 'p1', -1)).toBeNull()
    expect(stepTarget(ids(1), 'p1', 1)).toBeNull()
    expect(stepTarget(ids(1), 'p1', -1)).toBeNull()
    expect(stepTarget(ids(27), 'p26', 1)).toBe('p27')
    expect(stepTarget(ids(3), 'gone', 1)).toBeNull()
  })

  it('finds a plate by number from 1 or by id', () => {
    expect(findPlate(ids(27), 27)).toBe('p27')
    expect(findPlate(ids(27), 1)).toBe('p1')
    expect(findPlate(ids(27), 0)).toBeUndefined()
    expect(findPlate(ids(27), 28)).toBeUndefined()
    expect(findPlate(ids(27), 2.5)).toBeUndefined()
    expect(findPlate(ids(27), 'p13')).toBe('p13')
    expect(findPlate(ids(27), 'p99')).toBeUndefined()
  })

  it('shows the next and previous plate through the store, keeping each plate\'s objects', () => {
    const box = { id: 'o1', name: 'Box', parts: [], transform: [] } as never
    set({ plate: [box], activePlate: 'a', plates: [{ id: 'a', name: 'Plate 1', objects: [], settings: {} }, { id: 'b', name: 'Plate 2', objects: [], settings: {} }], slice: { status: 'idle' } })
    expect(stepPlate(1)).toBe('b')
    expect(get().activePlate).toBe('b')
    expect(get().plates[0]!.objects).toEqual([box])
    expect(stepPlate(1)).toBeNull()
    expect(get().activePlate).toBe('b')
    expect(stepPlate(-1)).toBe('a')
    expect(get().plate).toEqual([box])
  })
})

describe('each plate\'s slice state', () => {
  const s = (slice: object) => ({ plates: [{ id: 'a', name: 'A', objects: [], settings: {} }, { id: 'b', name: 'B', objects: [{} as never], settings: {} }], plate: [{} as never], activePlate: 'a', slice }) as never
  it('reads the slice on screen for the plate in view, and the kept slice for the others', () => {
    expect(sliceStateOf('a', 1, s({ status: 'idle' }), () => null)).toBe('not-sliced')
    expect(sliceStateOf('a', 1, s({ status: 'running' }), () => null)).toBe('slicing')
    expect(sliceStateOf('a', 1, s({ status: 'done', stale: false }), () => null)).toBe('sliced')
    expect(sliceStateOf('a', 1, s({ status: 'done', stale: true }), () => null)).toBe('stale')
    expect(sliceStateOf('b', 1, s({ status: 'idle' }), () => ({ stale: false }))).toBe('sliced')
    expect(sliceStateOf('b', 1, s({ status: 'idle' }), () => ({ stale: true }))).toBe('stale')
    expect(sliceStateOf('b', 0, s({ status: 'idle' }), () => ({ stale: false }))).toBe('empty')
  })

  it('numbers the plates from 1 and marks the shown one', () => {
    const rows = plateRows(s({ status: 'idle' }), () => null)
    expect(rows.map((r) => [r.number, r.id, r.objects, r.shown])).toEqual([[1, 'a', 1, true], [2, 'b', 1, false]])
  })
})

describe('the sheet\'s search and filter', () => {
  const row = (number: number, name: string, state: PlateRow['state']): PlateRow => ({ id: `p${number}`, number, name, objects: state === 'empty' ? 0 : 1, state, shown: number === 1 })
  const rows = [row(1, 'Shell, front half', 'sliced'), row(2, 'Shell, back half', 'not-sliced'), row(3, 'Label plate, racer', 'stale'), row(12, 'Feet, set of 4', 'not-sliced'), row(13, 'Plate 13', 'empty')]

  it('finds plates by every word of their name, or by number', () => {
    expect(filterPlates(rows, 'shell', false).map((r) => r.number)).toEqual([1, 2])
    expect(filterPlates(rows, 'SHELL back', false).map((r) => r.number)).toEqual([2])
    expect(filterPlates(rows, '12', false).map((r) => r.number)).toEqual([12])
    expect(filterPlates(rows, 'plate 3', false).map((r) => r.number)).toEqual([3])
    expect(filterPlates(rows, '4', false).map((r) => r.number)).toEqual([12])
    expect(filterPlates(rows, '  ', false)).toHaveLength(5)
    expect(filterPlates(rows, 'nothing', false)).toEqual([])
  })

  it('Not sliced keeps the plates with objects and no current slice, empty plates left out', () => {
    expect(filterPlates(rows, '', true).map((r) => r.number)).toEqual([2, 3, 12])
    expect(filterPlates(rows, 'shell', true).map((r) => r.number)).toEqual([2])
  })

  it('a plate named for its number shows no second name', () => {
    expect(plateSubtitle('Plate 4', 4)).toBe('')
    expect(plateSubtitle('Plate 4', 5)).toBe('Plate 4')
    expect(plateSubtitle(' Lid ', 2)).toBe('Lid')
  })
})

describe('the plate keys', () => {
  const key = (k: string, code: string, shift: boolean) => ({ key: k, code, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false }) as KeyboardEvent

  it('Shift+[ and Shift+] step plates in every look, with [ and ] left to the side panels', () => {
    for (const id of LOOK_IDS) {
      expect(KEYMAPS[id]['plate.prev'], id).toBe('Shift+[')
      expect(KEYMAPS[id]['plate.next'], id).toBe('Shift+]')
      expect([KEYMAPS[id]['panel.left'], KEYMAPS[id]['panel.right']], id).toEqual(['[', ']'])
      expect(keymapConflicts(KEYMAPS[id]), id).toEqual([])
    }
  })

  it('match the physical bracket keys, whatever character Shift makes on the layout', () => {
    // US: Shift+[ types {. A layout with brackets elsewhere still sends BracketLeft for that key.
    expect(matchShortcut(key('{', 'BracketLeft', true), 'Shift+[')).toBe(true)
    expect(matchShortcut(key('}', 'BracketRight', true), 'Shift+]')).toBe(true)
    expect(matchShortcut(key('ü', 'BracketLeft', true), 'Shift+[')).toBe(true)
    // The plain keys stay the panels', and Shift+[ is not the panel key.
    expect(matchShortcut(key('[', 'BracketLeft', false), 'Shift+[')).toBe(false)
    expect(matchShortcut(key('{', 'BracketLeft', true), '[')).toBe(false)
    expect(matchShortcut(key('[', 'BracketLeft', false), '[')).toBe(true)
    expect(matchShortcut(key('}', 'BracketRight', true), 'Shift+[')).toBe(false)
  })
})

describe('the sheet\'s size', () => {
  it('fits every plate, never resizes with a search (it counts all plates), and stops at the room it has', async () => {
    const { sheetHeight } = await import('../src/workspaces/prepare/plate-picker')
    expect(sheetHeight(1, 640, 480)).toBe(238)
    expect(sheetHeight(4, 640, 480)).toBe(238)
    expect(sheetHeight(5, 640, 480)).toBe(386)
    // Two and a half rows at most: 13, 20 or 27 plates scroll inside a sheet of one size.
    expect(sheetHeight(13, 640, 480)).toBe(464)
    expect(sheetHeight(20, 640, 480)).toBe(464)
    expect(sheetHeight(27, 640, 480)).toBe(464)
    expect(sheetHeight(27, 640, 260)).toBe(260)
    // Never more than four across, however wide.
    expect(sheetHeight(5, 1200, 480)).toBe(386)
    // A phone's narrower sheet has fewer columns, so more rows.
    expect(sheetHeight(3, 366, 600)).toBe(386)
    // The plate settings form gets room of its own.
    expect(sheetHeight(1, 640, 480, true)).toBe(320)
  })
})

describe('the picker\'s look (design spec 2 and 4)', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/app.css'), 'utf8')
  const rule = (selector: string) => css.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? ''
  it('has controls 34 px tall, the control height token', () => {
    expect(rule('.pp-step')).toContain('height: var(--h-md)')
    expect(rule('.pp-main')).toContain('height: var(--h-md)')
    expect(rule('.plate-picker')).toContain('height: calc(var(--h-md) + 8px)')
  })
  it('lifts the pill and the grid popover with the lift edge', () => {
    expect(rule('.plate-picker')).toContain('var(--shadow-float), var(--lift-edge)')
    expect(rule('.pp-sheet')).toContain('var(--shadow-pop), var(--lift-edge)')
  })
})
