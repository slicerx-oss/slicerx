// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sx refuses a plate whose paths cross, enter a keep-out zone (print paths, and travels in newer sx) or meet the
// toolhead (exit code 3), in the command line's words. This turns those words into an error code, a message for a person and the facts as details.
// Newer sx also prints the refused collisions as data on stdout, with the engine's object ids: each item then names
// its objects by id too (the plate object's own id where the request gave one), so two objects of one name stay apart.
import { ToolInputError } from './models'

/** The ids of the objects an item names: the plate objects' own ids when the request gave them, and the engine's. */
export interface CollisionIds {
  object_ids?: string[]
  engine_objects?: string[]
}

export type CollisionItem =
  | ({ kind: 'paths_cross'; objects: [string, string]; first_layer: number; last_layer: number } & CollisionIds)
  | ({ kind: 'keep_out'; zone: string; object: string; first_layer: number; last_layer: number } & CollisionIds)
  | ({ kind: 'clearance'; text: string } & CollisionIds)

/** One collision of sx's refusal on stdout (its `collisions`, camelCase as the slice result has them). */
export interface RefusedHit {
  kind: string
  severity: string
  objectId: string
  hitId: string
}

/** The zones and the tower sx names by fixed ids; they are no objects. */
const NOT_OBJECTS = new Set(['prime-tower', 'exclusion-area', 'wrap-check-zone'])

type V3 = [number, number, number]

/** One collision as sx writes it in its result and its refusal (camelCase), with the fields a client acts on. */
export interface SxCollision extends RefusedHit {
  part: string
  layer: number
  lastLayer: number
  timeS: number
  worstPoint: V3
  depthMm: number
  pushMm?: number
  limitMm?: number
  damagedId?: string
  contactMin?: V3
  contactMax?: V3
}

/**
 * A collision as the slice tools answer it, refused or sliced with allow_collisions. Positions are plate mm, from the
 * printable area's front left corner, as the app's plate counts them.
 */
export interface SliceCollision {
  index: number
  kind: string
  severity: 'hit' | 'close'
  part: string
  /** The object printing: the plate object's own id when the request gave one, else the engine's. */
  object_id: string
  object_name?: string
  /** What it meets: an object, the prime tower, or a keep-out zone (exclusion-area, wrap-check-zone). */
  hit_id: string
  hit_kind: 'object' | 'tower' | 'zone'
  /** The object whose material is struck; absent from an older engine. */
  damaged_id?: string
  /** Layers counted from 1, and when it first happens in the print. */
  first_layer: number
  last_layer: number
  time_s: number
  /** Where it goes deepest. */
  contact_point: V3
  /** The region struck; absent for a close call and from an older engine. */
  contact_box?: { min: V3; max: V3 }
  depth_mm: number
  push_mm?: number
  limit_mm?: number
}

/** sx's collisions from its result or its refusal on stdout, or [] when it printed none. */
export function sxCollisions(v: unknown): SxCollision[] {
  const list = (v as { collisions?: unknown } | null)?.collisions
  return Array.isArray(list) ? list.filter((h): h is SxCollision => !!h && typeof h === 'object' && typeof (h as SxCollision).objectId === 'string' && typeof (h as SxCollision).hitId === 'string' && Array.isArray((h as SxCollision).worstPoint)) : []
}

const round = (v: number) => Math.round(v * 100) / 100

/**
 * The collisions for a client: the engine's ids o0, o1 (and o0-1 for an object a project file expands to) as the plate
 * objects' own ids where the request gave them, the names, and positions moved by `origin` (the printable area's front
 * left corner in the machine's coordinates, where sx works) onto the plate.
 */
export function sliceCollisions(hits: readonly SxCollision[], objects: readonly { id?: string; name?: string }[], origin: readonly [number, number]): SliceCollision[] {
  const own = (id: string) => {
    const m = /^o(\d+)$/.exec(id)
    return m ? objects[Number(m[1])]?.id : undefined
  }
  const named = (id: string) => {
    const m = /^o(\d+)$/.exec(id)
    return m ? objects[Number(m[1])]?.name : undefined
  }
  const plate = (p: V3): V3 => [round(p[0] - origin[0]), round(p[1] - origin[1]), round(p[2])]
  return hits.map((h, index) => {
    const name = named(h.objectId)
    return {
      index,
      kind: h.kind,
      severity: h.severity === 'close' ? 'close' : 'hit',
      part: h.part,
      object_id: own(h.objectId) ?? h.objectId,
      ...(name ? { object_name: name } : {}),
      hit_id: own(h.hitId) ?? h.hitId,
      hit_kind: h.hitId === 'prime-tower' ? 'tower' : NOT_OBJECTS.has(h.hitId) ? 'zone' : 'object',
      ...(h.damagedId ? { damaged_id: own(h.damagedId) ?? h.damagedId } : {}),
      first_layer: h.layer + 1,
      last_layer: h.lastLayer + 1,
      time_s: Math.round(h.timeS),
      contact_point: plate(h.worstPoint),
      ...(h.contactMin && h.contactMax ? { contact_box: { min: plate(h.contactMin), max: plate(h.contactMax) } } : {}),
      depth_mm: round(h.depthMm),
      ...(h.pushMm ? { push_mm: round(h.pushMm) } : {}),
      ...(h.limitMm ? { limit_mm: round(h.limitMm) } : {}),
    }
  })
}

const ZONES = ['the prime tower', 'the exclusion area', 'the nozzle wrap check corner']
const LAYERS = String.raw`layers? (\d+)(?: to (\d+))?`

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const span = (first: number, last: number): string => (last > first ? `layers ${first} to ${last}` : `layer ${first}`)

/** Two names joined by " and ", preferring names the request used, since a file name can hold " and " too. */
function pair(text: string, names: readonly string[]): [string, string] {
  for (const a of names) {
    for (const b of names) {
      if (a !== b && text === `${a} and ${b}`) return [a, b]
    }
  }
  const at = text.indexOf(' and ')
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 5)]
}

/** The collision refusal in sx's stderr, or undefined when the failure is something else. */
export function parseCollisions(why: string, objectNames: readonly string[] = []): { items: CollisionItem[]; fixes: string[] } | undefined {
  const text = why.replace(/^.*?sx slice: /s, '').replace(/\s+/g, ' ')
  const names = [...ZONES, ...objectNames]
  const items: CollisionItem[] = []
  const clear = /printing by object is not safe: (.+?)(?= Paths cross: | A print path(?: or travel)? enters | To fix it: | To slice it anyway|$)/.exec(text)
  if (clear?.[1]) items.push({ kind: 'clearance', text: clear[1].trim() })
  for (const m of text.matchAll(new RegExp(String.raw`Paths cross: (.+?) on ${LAYERS}\.`, 'g'))) {
    const first = Number(m[2])
    items.push({ kind: 'paths_cross', objects: pair(m[1] ?? '', names), first_layer: first, last_layer: Number(m[3] ?? first) })
  }
  for (const m of text.matchAll(new RegExp(String.raw`A print path(?: or travel)? enters (.+?) on ${LAYERS}\.`, 'g'))) {
    const body = m[1] ?? ''
    const zone = ZONES.find((z) => body.startsWith(`${z}: `)) ?? body.slice(0, Math.max(0, body.indexOf(': ')))
    const first = Number(m[2])
    items.push({ kind: 'keep_out', zone, object: body.slice(zone.length + 2), first_layer: first, last_layer: Number(m[3] ?? first) })
  }
  if (items.length === 0) return undefined
  const fix = /To fix it: (.+?)\.(?= To slice it anyway|$)/.exec(text)
  return { items, fixes: fix?.[1] ? fix[1].split('; or ').map((f) => f.trim()).filter(Boolean) : [] }
}

/**
 * Each item with the ids of the objects it names, from sx's refused collisions (`hits`): the k-th crossing paths and
 * the k-th keep-out item are the k-th hits of their kind, and the by-object clearance item holds every other hit. The
 * engine's ids are o0, o1 for the request's objects, and o0-1, o0-2 for the objects a project file of one expands to;
 * `objects` are the request's objects in order, with the plate object's own id when they have one.
 */
export function withObjectIds(items: readonly CollisionItem[], hits: readonly RefusedHit[], objects: readonly { id?: string }[]): CollisionItem[] {
  const blocking = hits.filter((h) => h.severity === 'hit')
  const of = (kind: string) => blocking.filter((h) => h.kind === kind)
  const cross = of('path_conflict')
  const keep = of('keep_out')
  const machine = blocking.filter((h) => h.kind !== 'path_conflict' && h.kind !== 'keep_out')
  const seen = { paths_cross: 0, keep_out: 0 }
  const ids = (found: readonly RefusedHit[]): CollisionIds => {
    const engine = [...new Set(found.flatMap((h) => [h.objectId, h.hitId]))].filter((id) => id && !NOT_OBJECTS.has(id))
    if (engine.length === 0) return {}
    const own = engine.map((id) => {
      const m = /^o(\d+)(?:-[1-9]\d*)?$/.exec(id)
      const source = m ? objects[Number(m[1])] : undefined
      // A project file of one request object expands to several, and they share the request object's id.
      return source?.id && m && !id.includes('-') ? source.id : undefined
    })
    return { engine_objects: engine, ...(own.every((id) => id !== undefined) ? { object_ids: own as string[] } : {}) }
  }
  return items.map((item) => {
    if (item.kind === 'clearance') return { ...item, ...ids(machine) }
    const hit = (item.kind === 'paths_cross' ? cross : keep)[seen[item.kind]++]
    return hit ? { ...item, ...ids([hit]) } : item
  })
}

/** A person's sentence for each item and the fixes, with no command line flags. */
export function collisionMessage(items: readonly CollisionItem[], fixes: readonly string[]): string {
  const out = items.map((c) =>
    c.kind === 'paths_cross'
      ? `${cap(c.objects[0])} and ${c.objects[1]} overlap on ${span(c.first_layer, c.last_layer)}.`
      : c.kind === 'keep_out'
        ? `${cap(c.object)} prints into ${c.zone} on ${span(c.first_layer, c.last_layer)}.`
        : `Printing by object is not safe: ${c.text}`,
  )
  if (fixes.length) out.push(`To fix it, ${fixes.join(', or ')}.`)
  return out.join(' ')
}

/** sx's refused collisions from its stdout, or undefined when it printed none (an older sx) or something else. */
export function refusedHits(stdout: string): RefusedHit[] | undefined {
  try {
    const v = JSON.parse(stdout.trim()) as { refused?: unknown; collisions?: unknown }
    if (v.refused !== 'collision' || !Array.isArray(v.collisions)) return undefined
    return v.collisions.filter((h): h is RefusedHit => !!h && typeof h === 'object' && typeof (h as RefusedHit).objectId === 'string' && typeof (h as RefusedHit).hitId === 'string')
  } catch {
    return undefined
  }
}

/**
 * The error to throw for an sx collision refusal: collision for the plate's own paths, sequence_clearance when only the
 * by-object clearance fails. With sx's refused collisions (`refused`), each item names its objects by id too.
 */
export function collisionError(why: string, objectNames: readonly string[] = [], refused?: { hits: readonly RefusedHit[]; objects: readonly { id?: string }[]; list?: readonly SliceCollision[] }): ToolInputError | undefined {
  const parsed = parseCollisions(why, objectNames)
  if (!parsed) return undefined
  const plate = parsed.items.some((c) => c.kind !== 'clearance')
  const items = refused ? withObjectIds(parsed.items, refused.hits, refused.objects) : parsed.items
  return new ToolInputError(collisionMessage(parsed.items, parsed.fixes), plate ? 'collision' : 'sequence_clearance', {
    collisions: items,
    // Every collision with its part struck, place and region, as a sliced result's collisions has them.
    ...(refused?.list?.length ? { collision_list: refused.list } : {}),
    fixes: parsed.fixes,
    allow_collisions: true,
    // In a project, slicerx_arrange spaces a by-object plate by the clearance.
    ...(plate ? {} : { fix: 'slicerx_arrange' }),
  })
}
