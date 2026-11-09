// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The playback bar's words for the tool change it is in. The full line fits a wide bar; a narrow one (the right pane
// open on a laptop, or a phone) takes the short one, so the count still shows beside the layer.

export interface ChangeLabel {
  /** The words before the count, such as "Tool change" or "Change". */
  lead: string
  /** The change's number, from 1. */
  n: number
  count: number
  /** After the count: ", to slot N" on a wide bar, empty on a narrow one. */
  tail: string
  /** The full line, for the tooltip and screen readers. */
  full: string
}

export function changeLabel(swap: boolean, index: number, count: number, toSlot: number, short: boolean): ChangeLabel {
  const word = swap ? 'Filament change' : 'Tool change'
  const n = index + 1
  const full = `${word} ${n} of ${count}, to slot ${toSlot + 1}`
  return short ? { lead: 'Change', n, count, tail: '', full } : { lead: word, n, count, tail: `, to slot ${toSlot + 1}`, full }
}
