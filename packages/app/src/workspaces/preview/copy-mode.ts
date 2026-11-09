// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether a print on an IDEX printer runs in a copy mode, read from the slice's start G-code once per preview. In
// duplication or mirror mode both carriages print the whole time, each its own copy, so Preview plays no carriage park
// (toolChangerFor passes the flag on to toolChangerSpec). Only the lines before the first move are read, the way the
// purge reader reads the lines it needs, not the whole text.
import type { Host, PreviewBuffers } from '@slicerx/contracts'
import { lineOfSegment, lineText } from './gcode-lines'
import { holdText } from './gcode-source'

export type CopyMode = 'duplicate' | 'mirror'

/** How far to read when the preview's moves carry no line numbers: the start G-code is shorter than this. */
const START_LINES = 5000

/**
 * The copy mode lines of start G-code leave the printer in, from the last `M605` outside a comment: `S2` duplicates,
 * `S3` mirrors, and any other mode (one head, auto-park, backup) clears it. The Snapmaker J1's start G-code writes
 * `M605 S2 X162 R0` for a plate named IDEXDupl or IDEXCopy, `M605 S3` for IDEXMirr and `M605 S4` (backup) for
 * IDEXBack. The engine's copy check reads the same lines the same way.
 */
export function copyModeOf(lines: Iterable<string>): CopyMode | null {
  let mode: CopyMode | null = null
  for (const line of lines) {
    const words = (line.split(';')[0] ?? '').trim().split(/\s+/)
    if (words[0]?.toUpperCase() !== 'M605') continue
    const s = words.slice(1).find((w) => /^s/i.test(w))
    const v = s === undefined ? Number.NaN : Number(s.slice(1))
    mode = v === 2 ? 'duplicate' : v === 3 ? 'mirror' : null
  }
  return mode
}

/** The copy mode of the print behind preview `p`, read from the start of its G-code; null when there is none or no text. */
export async function loadCopyMode(host: Host, p: PreviewBuffers): Promise<CopyMode | null> {
  const hold = holdText(host)
  if (!hold.source) return null
  try {
    const src = await hold.source
    const first = p.extrasOffset >= 0 && p.segmentCount > 0 ? lineOfSegment(p, 0) : 0
    const end = Math.min(src.count, first > 1 ? first - 1 : START_LINES)
    if (end < 1) return null
    const w = await src.window(1, end)
    return copyModeOf((function* () {
      for (let n = 1; n <= end; n++) yield lineText(w, n)
    })())
  } catch {
    return null
  } finally {
    hold.release()
  }
}
