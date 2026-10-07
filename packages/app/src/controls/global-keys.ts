// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The look's own keys for slice, export and the command bar. The fixed Mod+Enter and Mod+K
// keep working next to them, so a key learned in one look is never taken away by another.
import type { Keymap } from '@slicerx/ui'
import { matchShortcut } from '../lib/keys'

export type LookCommand = 'slice' | 'export-gcode' | 'palette'

const PAIRS = [
  ['slice', 'slice'],
  ['export', 'export-gcode'],
  ['palette', 'palette'],
] as const

/** Controls that take a bare key themselves: Space presses a button, picks a radio, moves a slider. */
const TAKES_KEYS = 'button,a[href],input,select,textarea,[contenteditable],[role=button],[role=radio],[role=tab],[role=slider],[role=switch],[role=checkbox],[role=menuitem],[role=option]'

export function onControl(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(TAKES_KEYS) !== null
}

/**
 * Which command the look binds to this key press, if any. A bare key (Space for the command bar
 * in the OrcaSlicer style) is left alone on a focused control, on key repeat and in Preview, where
 * Space plays the layers.
 */
export function lookCommandFor(e: KeyboardEvent, map: Keymap, ctx: { workspace: string; onControl: boolean }): LookCommand | null {
  for (const [action, command] of PAIRS) {
    const chord = map[action]
    if (!chord || !matchShortcut(e, chord)) continue
    const bare = !/(^|\+)(Mod|Alt)\+/.test(chord)
    if (bare && (ctx.onControl || e.repeat || ctx.workspace === 'preview')) return null
    return command
  }
  return null
}
