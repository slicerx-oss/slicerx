// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open sketch's dimension boxes over the app link: sketch.boxes reads every shape's boxes (a rectangle's Width and
// Height, a line's Length and Angle, a circle's Diameter) with the sketch's dimensions, and sketch.box_set types a
// value into one, as the person does on the shape. The value drives the shape through the sketch's solver, or is kept
// driven when it would over-define the sketch; null frees the size again. Each answer is the sketch read back.
import { sketchBoxes } from '../cad/sketch-mode'
import { LinkError } from './methods-error'

const BOXES = ['width', 'height', 'length', 'angle', 'diameter']

function open() {
  const l = sketchBoxes()
  if (!l) throw new LinkError('not_found', 'no sketch is open: open one in Model first (Sketch on the bed or a face, or Edit sketch)')
  return l
}

export function readBoxes(): unknown {
  return open().read()
}

export async function setBox(args: Record<string, unknown>): Promise<unknown> {
  const l = open()
  const { loop, seg, box, value } = args
  if (!Number.isInteger(loop) || (loop as number) < 0) throw new LinkError('invalid_input', 'loop: a loop index from 0, as sketch.boxes lists it')
  if (seg !== undefined && (!Number.isInteger(seg) || (seg as number) < 0)) throw new LinkError('invalid_input', "seg: a line's segment index from 0")
  if (typeof box !== 'string' || !BOXES.includes(box)) throw new LinkError('invalid_input', `box: one of ${BOXES.join(', ')}`)
  if (value !== null && typeof value !== 'number' && typeof value !== 'string') throw new LinkError('invalid_input', 'value: a number (mm, or degrees for an angle), an expression, or null to free the size')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new LinkError('invalid_input', 'value: a finite number')
  try {
    return await l.set({ loop: loop as number, ...(seg !== undefined ? { seg: seg as number } : {}), box, value: value as number | string | null })
  } catch (e) {
    if (e instanceof LinkError) throw e
    throw new LinkError('invalid_input', e instanceof Error ? e.message : String(e))
  }
}
