// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pick filter in Model: Alt+1, Alt+2 and Alt+3, Shift to add or drop a kind, off in Slice and while sketching,
// clear of every look's keys, and a readout in plain words.
import { KEYMAPS, LOOK_IDS } from '@slicerx/ui'
import { describe, expect, it } from 'vitest'
import { nextFilter, PICK_KEYS, PICK_KINDS, pickKeyOf, pickKeysOn, pickReadout } from '../src/plate/pick-filter'

const key = (k: string, code: string, o: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key: k, code, ...o })

describe('the filter', () => {
  it('picks one kind, or adds and drops one with Shift, never none', () => {
    expect(nextFilter(['object'], 'face', 'only')).toEqual(['face'])
    expect(nextFilter(['object'], 'edge', 'toggle')).toEqual(['object', 'edge'])
    expect(nextFilter(['edge', 'object'], 'face', 'toggle')).toEqual(['object', 'face', 'edge'])
    expect(nextFilter(['object', 'face'], 'object', 'toggle')).toEqual(['face'])
    expect(nextFilter(['face'], 'face', 'toggle')).toEqual(['face'])
  })
})

describe('the keys', () => {
  it('read Alt and a digit by the physical key, as macOS changes the character', () => {
    expect(pickKeyOf(key('1', 'Digit1', { altKey: true }))).toEqual({ kind: 'object', mode: 'only' })
    expect(pickKeyOf(key('™', 'Digit2', { altKey: true }))).toEqual({ kind: 'face', mode: 'only' })
    expect(pickKeyOf(key('#', 'Digit3', { altKey: true, shiftKey: true }))).toEqual({ kind: 'edge', mode: 'toggle' })
  })

  it('leave bare digits and Mod+digit to the views and tabs', () => {
    expect(pickKeyOf(key('1', 'Digit1'))).toBeNull()
    expect(pickKeyOf(key('2', 'Digit2', { ctrlKey: true }))).toBeNull()
    expect(pickKeyOf(key('2', 'Digit2', { metaKey: true }))).toBeNull()
    expect(pickKeyOf(key('4', 'Digit4', { altKey: true }))).toBeNull()
  })

  it('work in Model only, and rest while a sketch is open', () => {
    expect(pickKeysOn({ workspace: 'prepare', modelMode: 'design', objectTool: null })).toBe(true)
    expect(pickKeysOn({ workspace: 'prepare', modelMode: 'design', objectTool: 'fillet' })).toBe(true)
    expect(pickKeysOn({ workspace: 'prepare', modelMode: 'design', objectTool: 'sketch' })).toBe(false)
    expect(pickKeysOn({ workspace: 'prepare', modelMode: 'slice', objectTool: null })).toBe(false)
    expect(pickKeysOn({ workspace: 'library', modelMode: 'design', objectTool: null })).toBe(false)
  })

  it('take no chord any look already uses', () => {
    const ours = PICK_KINDS.flatMap((k) => [PICK_KEYS[k], `Shift+${PICK_KEYS[k]}`]).map((c) => c.toLowerCase())
    for (const id of LOOK_IDS) {
      const used = Object.values(KEYMAPS[id]).filter((c): c is string => Boolean(c)).map((c) => c.toLowerCase())
      for (const c of ours) expect(used, `${id} ${c}`).not.toContain(c)
    }
  })
})

describe('the readout', () => {
  it('says what is picked in plain words', () => {
    expect(pickReadout({ objects: [] })).toBe('Nothing selected')
    expect(pickReadout({ objects: ['Bracket'] })).toBe('Bracket')
    expect(pickReadout({ objects: ['Bracket', 'Lid', 'Hinge'] })).toBe('3 objects')
    expect(pickReadout({ objects: ['Bracket'], faces: [{ object: 'Bracket' }] })).toBe('1 face on Bracket')
    expect(pickReadout({ objects: ['Bracket'], faces: [{ object: 'Bracket' }, { object: 'Bracket' }] })).toBe('2 faces on Bracket')
    expect(pickReadout({ objects: ['Bracket', 'Lid'], edges: [{ object: 'Bracket' }, { object: 'Lid' }, { object: 'Lid' }] })).toBe('3 edges on 2 objects')
    expect(pickReadout({ objects: ['Bracket'], faces: [{ object: 'Bracket' }], edges: [{ object: 'Bracket' }] })).toBe('1 face and 1 edge on Bracket')
  })
})
