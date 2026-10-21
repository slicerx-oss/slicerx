// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's steps in the person's words: what it is doing, and what it did. The tool's own name shows only in the row's
// tooltip. Questions, plans and lookups have no row: their cards say it.
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
  // the sheet's record says how it was answered; a row saying it again would show it twice
  'pilot.sheet': null,
  'pilot.sheet_bind': { doing: 'Linking the sizes to the part', done: 'Linked the sizes to the part' },
  'lookup.show': null,
  'design.plan': null,
  'design.new': { doing: 'Starting the design', done: 'Started the design' },
  'geom.extrude': { doing: 'Extruding the sketch', done: 'Extruded the sketch', caption: 'Extrude, Z', camera: 'iso' },
  'geom.revolve': { doing: 'Revolving the profile', done: 'Revolved the profile', caption: 'Revolve', camera: 'iso' },
  'geom.push_pull': { doing: 'Pushing the face', done: 'Pushed the face', caption: 'Push/pull' },
  'geom.fillet': { doing: 'Rounding the edges', done: 'Rounded the edges', caption: 'Fillet' },
  'geom.chamfer': { doing: 'Beveling the edges', done: 'Beveled the edges', caption: 'Chamfer' },
  'geom.boolean': { doing: 'Combining the bodies', done: 'Combined the bodies' },
  'geom.hole': { doing: 'Sizing the hole', done: 'Sized the hole', caption: 'Hole' },
  'geom.measure': { doing: 'Measuring', done: 'Measured' },
  'geom.info': { doing: 'Checking the part', done: 'Checked the part' },
  'design.check': { doing: 'Checking the part against its plan', done: 'Checked the part against its plan' },
  'design.undo': { doing: 'Undoing the last step', done: 'Undid the last step' },
  'app.slice': { doing: 'Slicing the plate', done: 'Sliced the plate' },
  'app.project_new': { doing: 'Starting a new project', done: 'Asked about a new project' },
  'settings.plan': { doing: 'Planning the settings', done: 'Planned the settings' },
  'settings.apply': { doing: 'Changing the settings', done: 'Changed the settings' },
  'project.info': { doing: 'Reading the project', done: 'Read the project' },
  'printer.list': { doing: 'Checking the printers', done: 'Checked the printers' },
  'printer.status': { doing: 'Checking the printer', done: 'Checked the printer' },
  'run.target': { doing: 'Picking the printer and spool', done: 'Picked the printer and spool' },
  'printer.queue': { doing: 'Sending to the printer', done: 'Sent to the printer' },
}

const GENERIC = { doing: 'Working on the design', done: 'Design step done' }
/** Any other tool (the app's commands, the guides, the skills): its own summary once done. */
const OTHER = { doing: 'Working', done: 'Step done' }

// an extrude that cuts or joins says so; its summary starts with the verb ("Cut: step 2, Extrude")
const EXTRUDED: Record<string, string> = { Cut: 'Cut into the part', Joined: 'Added to the part' }

export const stepWords: StepWords = (row) => {
  const w = WORDS[row.tool]
  if (w === null) return null
  const design = /^(design|geom)\./.test(row.tool)
  const base = w ?? (design ? GENERIC : { ...OTHER, done: row.summary ?? OTHER.done })
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
