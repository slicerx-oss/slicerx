// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The parts of an object for a connected client over the app link (parts.list, .clone, .order and .rename, the MCP server's
// app_parts tools): each edit is one undo step, the person sees a toast naming the client with Undo, and the parts read
// back.
import { appPartInputs, type AppParts } from '@slicerx/mcp/toolset'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { partNameProblem, stepName } from '@slicerx/cad-history'
import { effectiveSlot } from '../filament/slots'
import { history } from '../plate/history'
import { partOverridesOf } from '../plate/object-settings'
import { clonePart, isPartOrder, orderMoving, renamePart, reorderParts } from '../plate/parts'
import { bounds, identity } from '../plate/transform'
import { get, toast, type AppState, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

const round = (v: number): number => Math.round(v * 1000) / 1000

function object(s: AppState, name: string): PlateEntry {
  const exact = s.plate.find((p) => p.id === name)
  const matches = exact ? [exact] : s.plate.filter((p) => p.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  return matches[0]!
}

function input<K extends keyof typeof appPartInputs>(key: K, args: Record<string, unknown>): ReturnType<(typeof appPartInputs)[K]['parse']> {
  const parsed = appPartInputs[key].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return parsed.data as ReturnType<(typeof appPartInputs)[K]['parse']>
}

/** A part by index or by name; a name more than one part has must be given by index. */
function partIndex(e: PlateEntry, part: number | string): number {
  if (typeof part === 'number') {
    if (!e.parts[part]) throw new LinkError('not_found', `${e.name} has ${e.parts.length} part${e.parts.length === 1 ? '' : 's'}, from 0`)
    return part
  }
  const found = e.parts.flatMap((p, i) => (p.name === part ? [i] : []))
  if (!found.length) throw new LinkError('not_found', `${e.name} has no part named ${part}; app_parts lists them`)
  if (found.length > 1) throw new LinkError('invalid_input', `${found.length} parts are named ${part}; give its index`)
  return found[0]!
}

/** The paint layers with at least one painted triangle. */
const layers = (paint: object | undefined): string[] => Object.entries(paint ?? {}).flatMap(([k, v]) => (v && Object.keys(v as object).length ? [k] : []))

function state(s: AppState, e: PlateEntry): AppParts {
  return {
    object: { id: e.id, name: e.name },
    plate: s.activePlate,
    parts: e.parts.map((p, i) => {
      const b = bounds([p], identity())
      return {
        index: i,
        name: p.name,
        slot: effectiveSlot(e, p),
        triangles: p.indices.length / 3,
        painted: [...new Set([...layers(p.paint), ...layers(e.paint?.[i])])].sort(),
        // what the slice uses: an instance prints with its source's part settings
        settings: structuredClone(partOverridesOf(s.plate, e)[p.name] ?? {}),
        boundsMm: b ? { min: b.min.map(round), max: b.max.map(round) } : null,
      }
    }),
    history: e.history ? { steps: e.history.steps.length, last: e.history.steps.length ? stepName(e.history.steps.at(-1)!) : null } : null,
  }
}

export function readParts(args: Record<string, unknown>): AppParts {
  const i = input('list', args)
  const s = get()
  return state(s, object(s, i.object))
}

const entryOf = (id: string): PlateEntry => object(get(), id)

/** A client never changes what the person locked or is changing right now. */
async function editable(name: string): Promise<{ e: PlateEntry; guard: () => void }> {
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  const e = object(s, name)
  const guard = () => {
    const now = get()
    if (now.activePlate !== s.activePlate || now.plate.find((p) => p.id === e.id) !== e) throw new LinkError('busy', 'The object changed while its parts loaded; read it again and retry')
    if (now.rollback || now.plateLoading || now.dragging || now.liveEdit || now.historyEdit?.objectId === e.id || replaying(e.id)) throw new LinkError('busy', 'Finish the current load or object edit and return to the end of the timeline first')
  }
  if (e.locked) throw new LinkError('refused', `${e.name} is locked; the person unlocks it in the object list`)
  guard()
  return { e, guard }
}

/** The app's own refusals (an exact history, a part count that changed) as link errors. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof LinkError) throw err
    throw new LinkError('refused', err instanceof Error ? err.message : String(err))
  }
}

export async function partAction(action: 'clone' | 'order' | 'rename', args: Record<string, unknown>, client: string, loader: Loader | null): Promise<AppParts> {
  if (!loader) throw new LinkError('not_ready', 'The app is still starting its geometry loader')
  if (action === 'clone') {
    const i = input('clone', args)
    const { e, guard } = await editable(i.object)
    const index = partIndex(e, i.part)
    const made = await run(() => clonePart(loader, e.id, index, guard))
    if (!made) throw new LinkError('not_found', 'The part is gone')
    toast(`${client} cloned ${e.parts[index]!.name} in ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
    return { ...state(get(), object(get(), e.id)), cloned: made }
  }
  if (action === 'rename') {
    const i = input('rename', args)
    const { e, guard } = await editable(i.object)
    const index = partIndex(e, i.part)
    const was = e.parts[index]!.name
    const problem = partNameProblem(i.name, e.parts.map((p) => p.name), index)
    if (problem) throw new LinkError('invalid_input', `name: ${problem}`)
    const changed = await run(() => renamePart(loader, e.id, index, i.name, guard))
    if (changed) toast(`${client} renamed ${was} to ${entryOf(e.id).parts[index]!.name} in ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
    return { ...state(get(), object(get(), e.id)), changed }
  }
  const i = input('order', args)
  const { e, guard } = await editable(i.object)
  const moving = i.part !== undefined && i.to !== undefined
  if (!(moving ? i.order === undefined : i.order !== undefined && i.part === undefined && i.to === undefined)) throw new LinkError('invalid_input', 'Give order, or part with to')
  if (moving && i.to! >= e.parts.length) throw new LinkError('invalid_input', `to is an index from 0 to ${e.parts.length - 1}`)
  const order = moving ? orderMoving(e.parts.length, partIndex(e, i.part!), i.to!) : i.order!
  if (!isPartOrder(order, e.parts.length)) throw new LinkError('invalid_input', `order lists each of the ${e.parts.length} part indices once, from 0`)
  const changed = await run(() => reorderParts(loader, e.id, order, guard))
  if (changed) toast(`${client} reordered the parts of ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { ...state(get(), object(get(), e.id)), changed }
}
