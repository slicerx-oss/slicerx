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
  'design.new': { doing: 'Starting the design', done: 'Started the design' },
  'geom.extrude': { doing: 'Extruding the sketch', done: 'Extruded the sketch', caption: 'Extrude, Z', camera: 'iso' },
  'geom.revolve': { doing: 'Revolving the profile', done: 'Revolved the profile', caption: 'Revolve', camera: 'iso' },
  'geom.push_pull': { doing: 'Pushing the face', done: 'Pushed the face', caption: 'Push/pull' },
  'geom.fillet': { doing: 'Rounding the edges', done: 'Rounded the edges', caption: 'Fillet' },
  'geom.chamfer': { doing: 'Beveling the edges', done: 'Beveled the edges', caption: 'Chamfer' },
  'geom.boolean': { doing: 'Combining the bodies', done: 'Combined the bodies' },
  'geom.measure': { doing: 'Measuring', done: 'Measured' },
  'geom.info': { doing: 'Checking the part', done: 'Checked the part' },
  'design.undo': { doing: 'Undoing the last step', done: 'Undid the last step' },
}

const GENERIC = { doing: 'Working on the design', done: 'Design step done' }

// an extrude that cuts or joins says so; its summary starts with the verb ("Cut: step 2, Extrude")
const EXTRUDED: Record<string, string> = { Cut: 'Cut into the part', Joined: 'Added to the part' }

export const stepWords: StepWords = (row) => {
  const w = WORDS[row.tool]
  if (w === null) return null
  const base = w ?? GENERIC
  if (row.state === 'bad') return { ...base, done: row.summary ?? 'That step failed' }
  const verb = row.tool === 'geom.extrude' ? row.summary?.split(':')[0] : undefined
  return verb && EXTRUDED[verb] ? { ...base, done: EXTRUDED[verb] } : base
}

/** Adds the words for more tools (the design tools register theirs). */
export function wordsFor(tool: string): Words | null | undefined {
  return WORDS[tool]
}

export function addStepWords(more: Record<string, Words>): void {
  Object.assign(WORDS, more)
}
