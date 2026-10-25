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
export function collisionError(why: string, objectNames: readonly string[] = [], refused?: { hits: readonly RefusedHit[]; objects: readonly { id?: string }[] }): ToolInputError | undefined {
  const parsed = parseCollisions(why, objectNames)
  if (!parsed) return undefined
  const plate = parsed.items.some((c) => c.kind !== 'clearance')
  const items = refused ? withObjectIds(parsed.items, refused.hits, refused.objects) : parsed.items
  return new ToolInputError(collisionMessage(parsed.items, parsed.fixes), plate ? 'collision' : 'sequence_clearance', {
    collisions: items,
    fixes: parsed.fixes,
    allow_collisions: true,
    // In a project, slicerx_arrange spaces a by-object plate by the clearance.
    ...(plate ? {} : { fix: 'slicerx_arrange' }),
  })
}
