// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { duplicateObjects } from '../plate/clipboard'
import { history } from '../plate/history'
import { renameObject } from '../plate/object-list'
import { removeObjects } from '../plate/remove'
import { bounds, decompose, layOnFace, setRotation, type Vec3 } from '../plate/transform'
import { get, markStale, set, toast } from '../state/store'
import { LinkError } from './methods-error'
import { objectState } from './object-state'

type Action = 'rename' | 'duplicate' | 'remove_object' | 'lay_on_face'

/** Named object edits use the same operations as the app, without first changing its selection. */
export async function objectAction(action: Action, args: Record<string, unknown>, client: string) {
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  const name = args['object']
  if (typeof name !== 'string' || !name.trim()) throw new LinkError('invalid_input', 'Give an object id or name from the shown plate')
  const exact = s.plate.find((e) => e.id === name)
  const matches = exact ? [exact] : s.plate.filter((e) => e.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  const e = matches[0]!
  const affected = action === 'remove_object'
    ? [...s.plate, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)].filter((p) => p.id === e.id || p.instanceOf === e.id)
    : [e]
  if (s.rollback || affected.some((p) => s.historyEdit?.objectId === p.id || replaying(p.id))) throw new LinkError('busy', 'Finish the object edit and return to the end of the timeline first')
  if (e.locked && (action === 'remove_object' || action === 'lay_on_face')) throw new LinkError('refused', `${e.name} is locked; unlock it first`)
  let ids = [e.id]
  let removed: string[] = []
  let changed = true
  let summary: string
  let requested: number | undefined
  if (action === 'rename') {
    const value = args['name']
    if (typeof value !== 'string' || !value.replace(/[\u0000-\u001f]/g, '').trim() || value.length > 120) throw new LinkError('invalid_input', 'Give a nonempty object name of at most 120 characters')
    changed = renameObject(e.id, value)
    summary = `renamed ${e.name} to ${get().plate.find((p) => p.id === e.id)!.name}`
  } else if (action === 'duplicate') {
    const count = args['count'] === undefined ? 1 : args['count']
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) throw new LinkError('invalid_input', 'count must be a whole number from 1 to 50')
    requested = count
    ids = duplicateObjects([e.id], count)
    if (!ids.length) throw new LinkError('refused', 'No copy fits on this plate')
    summary = `duplicated ${e.name}: ${ids.length} of ${count} copies placed`
  } else if (action === 'remove_object') {
    removed = removeObjects([e.id])
    ids = get().plate.map((p) => p.id)
    summary = `removed ${e.name}`
  } else {
    const normal = args['normal']
    if (!Array.isArray(normal) || normal.length !== 3 || !normal.every((v) => typeof v === 'number' && Number.isFinite(v)) || Math.hypot(...normal) < 1e-9) throw new LinkError('invalid_input', 'normal must be a nonzero finite vector in the model coordinates')
    const scale = decompose(e.transform).scale
    if (scale.some((v) => !Number.isFinite(v) || Math.abs(v) < 1e-9)) throw new LinkError('refused', 'The object has a singular scale')
    const base = setRotation(e.parts, e.transform, [0, 0, 0])
    const box = bounds(e.parts, base)
    if (!box) throw new LinkError('refused', 'The object has no geometry to orient')
    const scaled = normal.map((v, i) => v / scale[i]!) as Vec3
    const center = box.min.map((v, i) => (v + box.max[i]!) / 2) as Vec3
    const transform = layOnFace(e.parts, base, scaled, center)
    changed = transform.some((v, i) => Math.abs(v - e.transform[i]!) > 1e-9)
    if (changed) {
      set({ plate: s.plate.map((p) => p.id === e.id ? { ...p, transform } : p) })
      markStale()
    }
    summary = `laid ${e.name} on its face`
  }
  const objects = get().plate.filter((p) => ids.includes(p.id)).map(objectState)
  if (changed) toast(`${client} ${summary}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { summary, output: { objects, ids, removed, ...(requested === undefined ? {} : { requested, created: ids.length }) } }
}
