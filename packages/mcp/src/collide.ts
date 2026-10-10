// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sx refuses a plate whose paths cross, enter a keep-out zone or meet the toolhead (exit code 3), in the command
// line's words. This turns those words into an error code, a message for a person and the facts as details.
import { ToolInputError } from './models'

export type CollisionItem =
  | { kind: 'paths_cross'; objects: [string, string]; first_layer: number; last_layer: number }
  | { kind: 'keep_out'; zone: string; object: string; first_layer: number; last_layer: number }
  | { kind: 'clearance'; text: string }

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
  const clear = /printing by object is not safe: (.+?)(?= Paths cross: | A print path enters | To fix it: | To slice it anyway|$)/.exec(text)
  if (clear?.[1]) items.push({ kind: 'clearance', text: clear[1].trim() })
  for (const m of text.matchAll(new RegExp(String.raw`Paths cross: (.+?) on ${LAYERS}\.`, 'g'))) {
    const first = Number(m[2])
    items.push({ kind: 'paths_cross', objects: pair(m[1] ?? '', names), first_layer: first, last_layer: Number(m[3] ?? first) })
  }
  for (const m of text.matchAll(new RegExp(String.raw`A print path enters (.+?) on ${LAYERS}\.`, 'g'))) {
    const body = m[1] ?? ''
    const zone = ZONES.find((z) => body.startsWith(`${z}: `)) ?? body.slice(0, Math.max(0, body.indexOf(': ')))
    const first = Number(m[2])
    items.push({ kind: 'keep_out', zone, object: body.slice(zone.length + 2), first_layer: first, last_layer: Number(m[3] ?? first) })
  }
  if (items.length === 0) return undefined
  const fix = /To fix it: (.+?)\.(?= To slice it anyway|$)/.exec(text)
  return { items, fixes: fix?.[1] ? fix[1].split('; or ').map((f) => f.trim()).filter(Boolean) : [] }
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

/** The error to throw for an sx collision refusal: collision for the plate's own paths, sequence_clearance when only the by-object clearance fails. */
export function collisionError(why: string, objectNames: readonly string[] = []): ToolInputError | undefined {
  const parsed = parseCollisions(why, objectNames)
  if (!parsed) return undefined
  const plate = parsed.items.some((c) => c.kind !== 'clearance')
  return new ToolInputError(collisionMessage(parsed.items, parsed.fixes), plate ? 'collision' : 'sequence_clearance', {
    collisions: parsed.items,
    fixes: parsed.fixes,
    allow_collisions: true,
  })
}
