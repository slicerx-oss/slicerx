// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's steps in the person's words: what it is doing, and what it did. The tool's own name shows only in the row's
// tooltip. Questions and lookups have no row: their cards say it.
import type { StepWords } from '@slicerx/pilot/ui'

const WORDS: Record<string, { doing: string; done: string } | null> = {
  'pilot.ask': null,
  'lookup.show': null,
}

const GENERIC = { doing: 'Working on the design', done: 'Design step done' }

export const stepWords: StepWords = (row) => {
  const w = WORDS[row.tool]
  if (w === null) return null
  const base = w ?? GENERIC
  return row.state === 'bad' ? { ...base, done: row.summary ?? 'That step failed' } : base
}

/** Adds the words for more tools (the design tools register theirs). */
export function addStepWords(more: Record<string, { doing: string; done: string }>): void {
  Object.assign(WORDS, more)
}
