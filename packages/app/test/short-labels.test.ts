// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Short names of long enum values (adapters/short-labels.ts): a closed select in Print settings must fit its 128 px
// column, and no short name may blur two choices into one.
import { describe, expect, it } from 'vitest'
import { SETTINGS } from '../src/adapters/settings'
import { SHORT_LABELS, shortLabel, WIDE_SELECTS } from '../src/adapters/short-labels'
import { offeredValues } from '../src/workspaces/prepare/expert-settings'

// Advance widths, px, of the select face (500 12px Hanken Grotesk), measured in the browser.
const WIDTH: Readonly<Record<string, number>> = { "0": 6.72, "1": 6.72, "2": 6.72, "3": 6.72, "4": 6.72, "5": 6.72, "6": 6.72, "7": 6.72, "8": 6.72, "9": 6.72, " ": 3.12, "!": 2.93, "\"": 4.16, "#": 8.36, "$": 6.72, "%": 8.92, "&": 8.29, "'": 2.16, "(": 2.88, ")": 2.88, "*": 4.78, "+": 6.72, ",": 2.88, "-": 3.92, ".": 2.88, "/": 5.03, ":": 2.88, ";": 2.88, "<": 6.72, "=": 6.72, ">": 6.72, "?": 6.19, "@": 10.49, "A": 7.79, "B": 7.25, "C": 8.47, "D": 8.15, "E": 7.0, "F": 6.76, "G": 8.78, "H": 8.2, "I": 3.02, "J": 6.64, "K": 7.73, "L": 5.98, "M": 10.14, "N": 8.16, "O": 8.98, "P": 6.68, "Q": 9.34, "R": 7.24, "S": 6.82, "T": 7.03, "U": 7.87, "V": 7.93, "W": 11.57, "X": 7.81, "Y": 7.32, "Z": 7.08, "[": 3.26, "\\": 5.45, "]": 3.26, "^": 6.92, "_": 5.21, "`": 3.59, "a": 6.5, "b": 7.0, "c": 6.23, "d": 7.0, "e": 6.48, "f": 4.07, "g": 6.2, "h": 6.64, "i": 2.78, "j": 2.78, "k": 6.49, "l": 3.23, "m": 10.0, "n": 6.64, "o": 6.9, "p": 7.0, "q": 7.0, "r": 4.96, "s": 5.65, "t": 4.24, "u": 6.64, "v": 6.31, "w": 9, "x": 6.32, "y": 6.31, "z": 5.66, "{": 3.05, "|": 3.14, "}": 3.05, "~": 6.72 }
const textWidth = (t: string) => [...t].reduce((n, c) => n + (WIDTH[c] ?? 9), 0)
// The select's frame: the border and left padding (8 px), the chevron's lane (28 px).
const FRAME = 36
const SELECT = 128

const selects = SETTINGS.filter((d) => d.type === 'enum' && d.section === 'process' && d.mode !== 'hidden' && d.key !== 'wall_generator')

describe('short names for long select values', () => {
  it('fit every option a Print settings select offers inside its column, short name or full', () => {
    const over: string[] = []
    for (const d of selects) {
      const budget = (WIDE_SELECTS[d.key] ?? SELECT) - FRAME
      for (const o of offeredValues(d, d.unavailableValues?.[0])) {
        const shown = shortLabel(d, o.value, o.label)
        if (textWidth(shown) > budget) over.push(`${d.key}: ${shown} (${Math.round(textWidth(shown))} px of ${budget})`)
      }
    }
    expect(over).toEqual([])
  })

  it('never give two options of one setting the same name', () => {
    const clash: string[] = []
    for (const d of selects) {
      const names = offeredValues(d, d.unavailableValues?.[0]).map((o) => shortLabel(d, o.value, o.label))
      if (new Set(names).size !== names.length) clash.push(`${d.key}: ${names.join(', ')}`)
    }
    expect(clash).toEqual([])
  })

  it('name only values that exist, and are shorter than their full name', () => {
    const bad: string[] = []
    for (const [key, map] of Object.entries(SHORT_LABELS)) {
      const d = SETTINGS.find((x) => x.key === key)
      for (const [value, short] of Object.entries(map)) {
        const i = d?.enumValues?.indexOf(value) ?? -1
        if (i < 0) bad.push(`${key}.${value} is not a value`)
        else if (short.length >= (d!.enumLabels?.[i] ?? '').length) bad.push(`${key}.${value} is not shorter`)
      }
    }
    expect(bad).toEqual([])
  })
})
