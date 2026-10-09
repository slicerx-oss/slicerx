// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The web pool serves a slice's G-code by lines: the line starts and byte ranges across the chunks it keeps, so the
// G-code view reads what it shows without a copy of the text.
import { describe, expect, it } from 'vitest'
import { byteRange, lineStarts } from '../../core/web/src/pool'
import { indexLines } from '../src/workspaces/preview/gcode-lines'

const enc = new TextEncoder()
const chunks = (...parts: string[]) => parts.map((p) => enc.encode(p).buffer as ArrayBuffer)

describe('G-code lines from the web pool', () => {
  it('finds the same line starts as the page across chunk edges, with or without a final break', async () => {
    for (const parts of [['G1 X1\nG1', ' X2\r\n;end'], ['a\n', 'b\n'], ['', 'one'], ['\n\n', 'x']]) {
      const whole = await indexLines(enc.encode(parts.join('')))
      expect(Array.from(await lineStarts(chunks(...parts)))).toEqual(Array.from(whole.starts))
    }
    // No text, no lines: the one start.
    expect(Array.from(await lineStarts(chunks('')))).toEqual([0])
  })

  it('copies a byte range out across chunk edges', () => {
    const c = chunks('abc', 'defg', 'hi')
    expect(new TextDecoder().decode(byteRange(c, 2, 8))).toBe('cdefgh')
    expect(new TextDecoder().decode(byteRange(c, 0, 9))).toBe('abcdefghi')
    expect(byteRange(c, 4, 4).length).toBe(0)
  })
})
