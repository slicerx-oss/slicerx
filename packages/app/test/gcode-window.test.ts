// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { indexLines, rangeSource, wholeSource } from '../src/workspaces/preview/gcode-lines'
import { GCODE_WINDOW_BYTES, readGcodeWindow } from '../src/workspaces/preview/gcode-window'

const enc = new TextEncoder()

it('reads a bounded range and supplies the next line without newline characters', async () => {
  const ix = await indexLines(enc.encode('G90\r\nM83\nG1 X1\n'))
  const reads: [number, number][] = []
  const src = rangeSource(ix.starts, async (a, b) => { reads.push([a, b]); return ix.bytes.slice(a, b) })
  const out = await readGcodeWindow(src, 2, 1)
  expect(out.lines).toEqual([{ number: 2, text: 'M83', byteOffset: 0, truncated: false }])
  expect(out.next).toEqual({ fromLine: 3, byteOffset: 0 })
  expect(reads).toEqual([[5, 9]])
  expect((await readGcodeWindow(src, 3, 200)).next).toBeNull()
})

it('continues a huge UTF-8 line without losing text or allocating an unbounded host read', async () => {
  const line = ';' + 'x'.repeat(GCODE_WINDOW_BYTES - 2) + '日🙂'.repeat(20000)
  const ix = await indexLines(enc.encode(line + '\nG90\n'))
  const reads: number[] = []
  const ranged = rangeSource(ix.starts, async (a, b) => { reads.push(b - a); return ix.bytes.slice(a, b) })
  for (const source of [ranged, wholeSource(ix)]) {
    let cursor: { fromLine: number; byteOffset: number } | null = { fromLine: 1, byteOffset: 0 }
    let first = ''
    let second = ''
    let calls = 0
    while (cursor) {
      const out = await readGcodeWindow(source, cursor.fromLine, 200, cursor.byteOffset)
      expect(out.bytesRead).toBeLessThanOrEqual(GCODE_WINDOW_BYTES)
      expect(out.lines.every((l) => !l.text.includes('\uFFFD'))).toBe(true)
      for (const part of out.lines) { if (part.number === 1) first += part.text; else second += part.text }
      expect(out.next).not.toEqual(cursor)
      cursor = out.next
      if (++calls > 10) throw new Error('continuation did not advance')
    }
    expect(first).toBe(line)
    expect(second).toBe('G90')
    expect(calls).toBeGreaterThan(1)
  }
  expect(Math.max(...reads)).toBeLessThanOrEqual(GCODE_WINDOW_BYTES)
})

it('refuses offsets outside a line or inside a UTF-8 character', async () => {
  const ix = await indexLines(enc.encode('日\nG90\n'))
  for (const source of [wholeSource(ix), rangeSource(ix.starts, async (a, b) => ix.bytes.slice(a, b))]) {
    await expect(readGcodeWindow(source, 1, 1, 5)).rejects.toThrow('outside')
    await expect(readGcodeWindow(source, 1, 1, 1)).rejects.toThrow('UTF-8')
  }
})

it('returns no lines for an empty source', async () => {
  const ix = await indexLines(new Uint8Array())
  expect(await readGcodeWindow(wholeSource(ix), 1, 40)).toMatchObject({ lines: [], next: null, bytesRead: 0 })
})

it('keeps CRLF out of text when the byte boundary falls between its two bytes', async () => {
  const text = ';' + 'x'.repeat(GCODE_WINDOW_BYTES - 2)
  const ix = await indexLines(enc.encode(text + '\r\nG90\n'))
  const source = wholeSource(ix)
  const first = await readGcodeWindow(source, 1, 2)
  const next = first.next!
  const second = await readGcodeWindow(source, next.fromLine, 2, next.byteOffset)
  expect([...first.lines, ...second.lines].filter((l) => l.number === 1).map((l) => l.text).join('')).toBe(text)
  expect(second.lines.at(-1)?.text).toBe('G90')
  expect(second.next).toBeNull()
})
