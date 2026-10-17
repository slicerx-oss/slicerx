// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PreviewBuffers } from '@slicerx/contracts'
import { set } from '../../state/store'
import { currentSegment, lineOfSegment, segmentOfLine, slidersFor } from './gcode-lines'

/** The line at the nozzle, or zero before any move or without line mapping. */
export function lineAtNozzle(p: PreviewBuffers, layerHi: number, moveCut: number): number {
  return lineOfSegment(p, currentSegment(p, layerHi, moveCut))
}

/** Moves the sliders to a line's move. False before the first move or without line mapping. */
export function jumpToLine(p: PreviewBuffers, line: number): boolean {
  const seg = segmentOfLine(p, line)
  if (seg < 0) return false
  set({ ...slidersFor(p, seg), toolChange: null })
  return true
}

/** The panel and client choose a line the same way, including text before the first move. */
export function selectGcodeLine(p: PreviewBuffers, line: number): void {
  if (p.extrasOffset >= 0 && !jumpToLine(p, line)) set({ layerHi: 1, moveCut: 0, toolChange: null })
}
