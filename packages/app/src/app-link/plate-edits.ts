// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moving, rotating and scaling objects on the shown plate for an agent over the app link (project.move, .rotate and
// .scale, the same names and arguments as the MCP server's own). Each call is one undo step, and the person sees a
// toast naming the agent and what it did, with Undo.
import { arrange } from '../plate/arrange'
import { getArrangeOptions, sourceOf } from '../plate/edit'
import { history } from '../plate/history'
import { bounds, setRotation, setScale, type Mat4, type Vec3 } from '../plate/transform'
import { get, markStale, set, toast, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'

const round = (v: number): number => Math.round(v * 1000) / 1000

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum)

/** The object an agent names, by id or by name, on the shown plate. A copy's name finds the object it copies. */
function find(object: unknown): PlateEntry {
  if (typeof object !== 'string' || !object) throw new LinkError('invalid_input', 'object is an id or a name from plate.list')
  const plate = get().plate
  const byId = plate.find((e) => e.id === object)
  if (byId) return byId
  const named = plate.filter((e) => e.name === object && !e.instanceOf)
  if (named.length > 1) throw new LinkError('invalid_input', `${named.length} objects are named ${object}; name one by id: ${named.map((e) => e.id).join(', ')}`)
  if (!named[0]) throw new LinkError('not_found', `no object ${object} on the shown plate; plate.list lists them`)
  return named[0]
}

/** An agent never moves what the person locked or is changing right now. */
async function editable(e: PlateEntry): Promise<void> {
  if (e.locked) throw new LinkError('refused', `${e.name} is locked; the person unlocks it in the object list`)
  const { replaying } = await import('../cad/history/ops')
  if (get().historyEdit?.objectId === e.id || replaying(e.id)) throw new LinkError('busy', 'the person is changing that object in the app; try again when they are done')
}

/** Writes new transforms in one store update (one undo step), tells the person, and reads the objects back. */
function commit(changed: Record<string, Mat4>, said: string, client: string) {
  const plate = get().plate.map((e) => (changed[e.id] ? { ...e, transform: changed[e.id]! } : e))
  set({ plate })
  markStale()
  toast(`${client} ${said}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return {
    objects: plate
      .filter((e) => changed[e.id])
      .map((e) => {
        const b = bounds(e.parts, e.transform)
        return { id: e.id, name: e.name, transform: e.transform.map(round), ...(b ? { minMm: b.min.map(round), maxMm: b.max.map(round), sizeMm: b.max.map((v, i) => round(v - b.min[i]!)) } : {}) }
      }),
  }
}

/** The object and its copies on the shown plate, which turn and scale together as in the object list. */
const family = (e: PlateEntry): PlateEntry[] => get().plate.filter((o) => sourceOf(o) === sourceOf(e))

/**
 * project.move: x and y put the center of the object's footprint there, in the plate's coordinates (plate.list's).
 * auto: true puts it in free space among the others instead. It moves this object only; its copies stay where they are.
 */
export async function move(args: Record<string, unknown>, client: string) {
  const e = find(args['object'])
  const auto = args['auto'] === true
  if (!auto && !(isNum(args['x']) && isNum(args['y']))) throw new LinkError('invalid_input', 'move takes x and y in mm, or auto: true')
  await editable(e)
  const b = bounds(e.parts, e.transform)
  if (!b) throw new LinkError('refused', `${e.name} has no geometry to move`)
  let to: Mat4
  if (auto) {
    const t = arrange([e], get().plate.filter((o) => o.id !== e.id), get().bed, { ...getArrangeOptions(), rotate: false }).transforms[e.id]
    if (!t) throw new LinkError('refused', `${e.name} has no free space on the plate`)
    to = t
  } else {
    to = [...e.transform]
    to[12] = (to[12] ?? 0) + (args['x'] as number) - (b.min[0] + b.max[0]) / 2
    to[13] = (to[13] ?? 0) + (args['y'] as number) - (b.min[1] + b.max[1]) / 2
  }
  return commit({ [e.id]: to }, auto ? `moved ${e.name} into free space` : `moved ${e.name}`, client)
}

/** project.rotate: degrees about X, then Y, then Z, absolute. The object and its copies are set back down on the bed. */
export async function rotate(args: Record<string, unknown>, client: string) {
  const e = find(args['object'])
  const r = args['rotate']
  if (!vec3(r)) throw new LinkError('invalid_input', 'rotate is [x, y, z] in degrees')
  await editable(e)
  const changed = Object.fromEntries(family(e).filter((o) => !o.locked).map((o) => [o.id, setRotation(o.parts, o.transform, r)]))
  return commit(changed, `rotated ${e.name}`, client)
}

/** project.scale: one factor or one per axis, absolute (1 is as modeled), up to 100. The object and its copies. */
export async function scale(args: Record<string, unknown>, client: string) {
  const e = find(args['object'])
  const v = args['scale']
  const s: unknown = isNum(v) ? [v, v, v] : v
  if (!vec3(s) || s.some((f) => f <= 0 || f > 100)) throw new LinkError('invalid_input', 'scale is a factor above 0 and up to 100, or [x, y, z] of them')
  await editable(e)
  const changed = Object.fromEntries(family(e).filter((o) => !o.locked).map((o) => [o.id, setScale(o.parts, o.transform, s)]))
  return commit(changed, `scaled ${e.name}`, client)
}
