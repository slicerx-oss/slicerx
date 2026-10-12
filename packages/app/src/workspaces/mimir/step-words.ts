// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's steps in the person's words: what it is doing, and what it did. The tool's own name shows only in the row's
// tooltip. Questions and lookups have no row: their cards say it.
import type { StepWords } from '@slicerx/pilot/ui'

/** A step's words, and optionally the caption the view shows while it runs and the view the camera turns to after. */
export interface Words {
  doing: string
  done: string
  caption?: string
  camera?: 'top' | 'iso' | 'front'
}

const WORDS: Record<string, Words | null> = {
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
export function wordsFor(tool: string): Words | null | undefined {
  return WORDS[tool]
}

export function addStepWords(more: Record<string, Words>): void {
  Object.assign(WORDS, more)
}
