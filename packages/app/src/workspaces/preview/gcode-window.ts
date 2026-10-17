// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LineSource } from './gcode-lines'

export const GCODE_WINDOW_BYTES = 65536

/** Stop before an incomplete UTF-8 character so the continuation starts at its first byte. */
function completeEnd(bytes: Uint8Array, start: number, end: number): number {
  if (end <= start) return end
  let at = end - 1
  while (at > start && (bytes[at]! & 0xc0) === 0x80) at--
  const lead = bytes[at]!
  const size = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1
  return at + size > end ? at : end
}

/** Reads bounded text without losing the rest of a long line; next resumes at a UTF-8 boundary. */
export async function readGcodeWindow(source: LineSource, from: number, count: number, byteOffset = 0) {
  const to = Math.min(source.count, from + count - 1)
  const ix = await source.window(from, to, GCODE_WINDOW_BYTES, byteOffset)
  const base = ix.base ?? 0
  if (byteOffset > 0 && ix.bytes.length && (ix.bytes[0]! & 0xc0) === 0x80) throw new RangeError('byteOffset must start at a UTF-8 character')
  const lines: { number: number; text: string; byteOffset: number; truncated: boolean }[] = []
  let next: { fromLine: number; byteOffset: number } | null = null
  for (let n = from; n <= to; n++) {
    const offset = n === from ? byteOffset : 0
    const a = ix.starts[n - 1]! + offset - base
    const end = ix.starts[n]! - base
    if (a >= ix.bytes.length && end > a) { next = { fromLine: n, byteOffset: offset }; break }
    const truncated = end > ix.bytes.length
    let b = truncated ? completeEnd(ix.bytes, a, ix.bytes.length) : end
    // Keep a possible CRLF pair together across pages.
    if (truncated && b > a && ix.bytes[b - 1] === 13) b--
    const consumed = b - a
    if (!truncated) {
      if (b > a && ix.bytes[b - 1] === 10) b--
      if (b > a && ix.bytes[b - 1] === 13) b--
    }
    lines.push({ number: n, text: new TextDecoder().decode(ix.bytes.subarray(a, b)), byteOffset: offset, truncated })
    if (truncated) { next = { fromLine: n, byteOffset: offset + consumed }; break }
    next = n < source.count ? { fromLine: n + 1, byteOffset: 0 } : null
  }
  return { lines, next, bytesRead: ix.bytes.length, maxBytes: GCODE_WINDOW_BYTES }
}
