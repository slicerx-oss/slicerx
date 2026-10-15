// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull as the person has it open, over the app link: model.push reads the picked face, the distance in its
// Distance box and the operation it makes (Pull out, Cut, Cut through); model.push_set types a distance into that box
// for the person to see and apply with Enter. Neither changes the project: the push runs only when the person applies
// it (geom.push_pull is the client's own way to push a face).
import { get } from '../state/store'
import { distanceText, OP_LABEL, pushActions, pushOperation, pushSnapshot, type PushSnapshot } from '../cad/push-session'
import { LinkError } from './methods-error'

const round = (v: number): number => Math.round(v * 1000) / 1000

function state(p: PushSnapshot | null) {
  const open = get().objectTool === 'push' && p !== null
  const op = p ? pushOperation(p.distanceMm, p.face?.thicknessMm ?? null) : null
  return {
    open,
    face: open && p?.face ? { object: p.face.objectId, part: p.face.partIndex, at: p.face.at.map(round), normal: p.face.normal.map(round), thicknessMm: p.face.thicknessMm === null ? null : round(p.face.thicknessMm) } : null,
    text: open ? (p?.text ?? '') : '',
    distanceMm: open ? (p?.distanceMm ?? null) : null,
    operation: open && op ? op : null,
    operationLabel: open && op ? OP_LABEL[op] : null,
    busy: open ? (p?.busy ?? false) : false,
    ...(open && p?.note ? { note: p.note } : {}),
    ...(open && p?.editStep ? { editStep: p.editStep } : {}),
  }
}

/** The open Push and pull: its face, its pending distance and the operation it makes. `open` is false while it is shut. */
export function readPush() {
  return state(pushSnapshot())
}

/** Waits until the tool shows `text` (its state settles a render later), then reads it back. */
async function settled(text: string): Promise<ReturnType<typeof readPush>> {
  for (let i = 0; i < 40; i++) {
    const p = pushSnapshot()
    if (!p || p.text === text) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return readPush()
}

/** Types a distance (mm) into the open tool's Distance box, as the person would; the person applies it. */
export async function setPush(args: Record<string, unknown>) {
  const extra = Object.keys(args).filter((k) => k !== 'distanceMm')
  if (extra.length) throw new LinkError('invalid_input', `model.push_set takes distanceMm only, not ${extra.join(', ')}`)
  const d = args['distanceMm']
  if (typeof d !== 'number' || !Number.isFinite(d)) throw new LinkError('invalid_input', 'distanceMm is a number of millimeters: positive pulls out, negative cuts')
  if (Math.abs(d) > 10_000) throw new LinkError('invalid_input', 'distanceMm is at most 10000 mm either way')
  const a = pushActions()
  if (get().objectTool !== 'push' || !a) throw new LinkError('not_found', 'Push and pull is not open; the person opens it and picks a face')
  if (pushSnapshot()?.busy) throw new LinkError('busy', 'Push and pull is running a push')
  const text = distanceText(d)
  a.setText(text)
  return settled(text)
}
