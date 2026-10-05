// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { keymapFor, matchShortcut } from '../src/controls/actions'
import { chordOf } from '../src/controls/actions'
import { withKey } from '../src/controls/section'
import { KEYMAPS, keymapConflicts, LOOK_IDS } from '@slicerx/ui'

const ev = (o: Partial<KeyboardEvent> & { key: string; code: string }) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o })

describe('chords from key events', () => {
  it('writes letters by the physical key, with Mod and Shift', () => {
    expect(chordOf(ev({ key: 'a', code: 'KeyA' }), false)).toBe('A')
    expect(chordOf(ev({ key: 'A', code: 'KeyA', shiftKey: true }), false)).toBe('Shift+A')
    expect(chordOf(ev({ key: 'g', code: 'KeyG', ctrlKey: true }), false)).toBe('Mod+G')
    expect(chordOf(ev({ key: 'g', code: 'KeyG', metaKey: true }), true)).toBe('Mod+G')
    expect(chordOf(ev({ key: 'å', code: 'KeyA', altKey: true }), false)).toBe('Alt+A')
  })

  it('names arrows and space, and ignores a bare modifier', () => {
    expect(chordOf(ev({ key: 'ArrowUp', code: 'ArrowUp' }), false)).toBe('Up')
    expect(chordOf(ev({ key: ' ', code: 'Space' }), false)).toBe('Space')
    expect(chordOf(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false)).toBeNull()
  })

  it('round trips: a chord the capture writes matches the same event', () => {
    for (const e of [ev({ key: '?', code: 'Slash', shiftKey: true }), ev({ key: 'k', code: 'KeyK', ctrlKey: true }), ev({ key: '1', code: 'Digit1' })]) {
      const c = chordOf(e, false)!
      expect(matchShortcut(e as KeyboardEvent, c)).toBe(true)
    }
  })
})

describe('key overrides', () => {
  it('stores a change and drops it again when it equals the preset', () => {
    const base = { id: 'bambu-studio' as const }
    const a = withKey(base, 'plate.arrange', 'J')
    expect(a.overrides?.keys).toEqual({ 'plate.arrange': 'J' })
    expect(keymapFor(a.id, a.overrides?.keys)['plate.arrange']).toBe('J')
    expect(withKey(a, 'plate.arrange', 'A')).toEqual({ id: 'bambu-studio' })
    expect(withKey(a, 'plate.arrange', undefined)).toEqual({ id: 'bambu-studio' })
  })

  it('clears a binding with an empty override and keeps other overrides', () => {
    const base = { id: 'slicerx' as const, overrides: { layout: { sidebar: { side: 'right' } } } } as never
    const a = withKey(base, 'tool.move', '')
    expect(keymapFor('slicerx', (a as { overrides: { keys: Record<string, string> } }).overrides.keys)['tool.move']).toBeNull()
    expect((a as { overrides: { layout: unknown } }).overrides.layout).toBeDefined()
    const b = withKey(a, 'tool.move', undefined)
    expect((b as { overrides: { keys?: unknown } }).overrides.keys).toBeUndefined()
  })
})

describe('look keymaps', () => {
  it('no look binds two actions to one key', () => {
    for (const id of LOOK_IDS) expect(keymapConflicts(KEYMAPS[id]), id).toEqual([])
  })

  it('no look binds an action to the command bar key, which belongs to the bar in every look', () => {
    for (const id of LOOK_IDS) {
      const clash = Object.entries(KEYMAPS[id]).filter(([a, c]) => a !== 'palette' && c?.toLowerCase() === 'mod+k')
      expect(clash, id).toEqual([])
    }
  })

  it('the paste key is the browser one in every look, so a system clipboard paste can carry files', () => {
    for (const id of LOOK_IDS) expect(KEYMAPS[id]['edit.paste'], id).toBe('Mod+V')
  })
})
