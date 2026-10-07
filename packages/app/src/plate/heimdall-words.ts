// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The words for heimdall's collisions and fixes. The engine reports codes, numbers and object ids; every sentence the
// person reads is written here, in one place, ready for translation.
import type { Collision, CollisionFix } from '@slicerx/contracts'

/** The plate's object names by id. */
export type Names = (id: string) => string

/** Object names and the tool changer's station of the app's plate and printer. */
export function wordsOf(s: { plate: readonly { id: string; name: string }[]; profile: { printerId: string } | null }): { name: Names; station: string } {
  return { name: namesOf(s.plate), station: stationOf(s.profile?.printerId) }
}

/** What the engine names besides the plate's objects. */
const OTHERS: Record<string, string> = { 'prime-tower': 'the prime tower', 'exclusion-area': 'an exclusion area', 'wrap-check-zone': 'the nozzle wrap check corner' }

export function namesOf(plate: readonly { id: string; name: string }[]): Names {
  return (id) => plate.find((p) => p.id === id)?.name ?? OTHERS[id] ?? 'an object'
}

/** What the head goes to during a tool change, by the printer profile id (the changers `toolChangerSpec` models). */
export function stationOf(printerId: string | null | undefined): string {
  const id = printerId ?? ''
  if (id.startsWith('bambu-h2c')) return 'hotend rack'
  if (id === 'snapmaker-u1' || id.startsWith('prusa-xl')) return 'tool dock'
  if (id.startsWith('ultimaker-s')) return 'switch bay'
  return id.startsWith('bambu-') ? 'purge chute' : 'tool changer'
}

const mm = (v: number, digits = 1) => `${v.toFixed(digits)} mm`

/** One line naming what meets what. */
export function collisionTitle(c: Collision, name: Names, station = 'tool changer'): string {
  const b = name(c.hitId)
  if (c.kind === 'path_conflict') return `Paths of ${name(c.objectId)} cross ${b}`
  if (c.kind === 'keep_out') return `${name(c.objectId)} prints into ${b}`
  if (c.severity === 'close') return `The toolhead passes close to ${b}`
  if (c.kind === 'gantry') return `The ${c.part === 'lid' ? 'frame' : 'gantry'} hits ${b}`
  if (c.kind === 'nozzle_travel_through_part') return `A travel runs through ${b}`
  if (c.kind === 'tool_change') return `A tool change crosses ${b}`
  if (c.kind === 'dock') return `The ${station} meets ${b}`
  // What is left prints: the nozzle or the toolhead.
  return c.part === 'nozzle' ? `The nozzle prints into ${b}` : `The toolhead hits ${b}`
}

/**
 * A close call on the Print sheet: one short line, then the numbers for the Details tip (the sheet's lines split at the
 * first sentence).
 */
export function closeCallNote(c: Collision, name: Names): string {
  const r = c.lastLayer > c.layer ? `layers ${c.layer + 1} to ${c.lastLayer + 1}` : `layer ${c.layer + 1}`
  const limit = (c.limitMm ?? 0).toFixed(0)
  return `${name(c.objectId)} passes inside the profile's margin around ${name(c.hitId)}. The nozzle comes within ${mm(Math.max(0, (c.limitMm ?? 0) - c.depthMm))} of it, where the profile asks for ${limit} mm; the head's own shape clears it, ${r}.`
}

/** Why it happens, with the numbers. */
export function collisionDetail(c: Collision, name: Names, station = 'tool changer'): string {
  const a = name(c.objectId)
  const b = name(c.hitId)
  const z = mm(c.at[2], 2)
  const r = c.lastLayer > c.layer ? `, layers ${c.layer + 1} to ${c.lastLayer + 1}` : `, on layer ${c.layer + 1}`
  const tall = `${b}, which stands ${mm(c.hitHeightMm)} tall${r}.`
  const limit = c.limitMm ?? 0
  if (c.kind === 'path_conflict') return `The paths of ${a} and ${b} cross where they overlap on the plate${r}.`
  if (c.kind === 'keep_out')
    return c.hitId === 'wrap-check-zone' ? `The printer checks this corner for filament wrapped round the nozzle, and ${a} prints into it${r}.` : `${a} prints into an area the printer keeps clear${r}.`
  if (c.severity === 'close')
    return `While ${a} prints, the nozzle comes within ${mm(Math.max(0, limit - c.depthMm))} of ${b}. The printer profile asks for ${limit.toFixed(0)} mm around the nozzle; the head's own shape clears ${b}, so this is the profile's margin, not a hit${r}.`
  if (c.kind === 'gantry' && c.part === 'lid') return `${b} is ${mm(c.hitHeightMm)} tall. Over the whole bed the printer clears ${mm(limit)} above the nozzle, so ${b} is in the way while ${a} prints${r}.`
  if (c.kind === 'gantry') return `${b} is ${mm(c.hitHeightMm)} tall. The gantry clears ${mm(limit)} above the nozzle, and it passes over ${b} while ${a} prints${r}.`
  if (c.kind === 'nozzle_travel_through_part') return `Moving across ${a} at ${z}, the nozzle passes through ${tall}`
  const piece = c.part === 'gantry' ? 'gantry' : c.part === 'nozzle' ? 'nozzle' : 'toolhead'
  if (c.kind === 'tool_change') return `On the way to the ${station} at ${z}, the ${piece} passes through ${tall}`
  if (c.kind === 'dock') return `At the ${station}, with ${a} at ${z}, the ${piece} reaches ${tall}`
  // What is left prints: the nozzle or the toolhead.
  if (c.part === 'nozzle') return `A move of ${a} at ${z} passes through ${tall}`
  return `While ${a} prints at ${z}, the toolhead reaches ${mm(Math.max(0.1, c.pushMm ?? 0))} into ${tall}`
}

/** How many of the list a fix clears. */
/** How many of one kind a fix clears, out of how many the plate has of that kind. */
function some(n: number, total: number, noun: string): string {
  if (n === 1) return total === 1 ? `the ${noun}` : `1 ${noun}`
  if (n === 2 && total === 2) return `both ${noun}s`
  return n === total ? `all ${n} ${noun}s` : `${n} of the ${total} ${noun}s`
}

/** What a fix clears, strikes and close calls named apart: "both strikes", "1 strike and the close call". */
function clears(f: CollisionFix, list: readonly Collision[]): string {
  const of = (sev: Collision['severity']) => [f.clears.filter((i) => list[i]?.severity === sev).length, list.filter((c) => c.severity === sev).length] as const
  const [hit, hits] = of('hit')
  const [close, closes] = of('close')
  const parts = [hit ? some(hit, hits, 'strike') : '', close ? some(close, closes, 'close call') : ''].filter(Boolean)
  return parts.length ? parts.join(' and ') : `${f.clears.length === 1 ? 'it' : `${f.clears.length} of them`}`
}

/** The close calls a new order still leaves, as a sentence, or nothing. */
function leaves(f: CollisionFix): string {
  const n = f.closeCalls ?? 0
  return n ? ` Leaves ${n === 1 ? 'a close call' : `${n} close calls`}: the head passes inside the profile's margin, but clears.` : ''
}

/** The fix as a short instruction. `order` is the plate's current order of object ids. */
/** The fix clears paths in a keep-out zone (a move out of the zone, not out of the tool changer's way). */
const zone = (f: CollisionFix, list: readonly Collision[]) => f.clears.some((i) => list[i]?.kind === 'keep_out')

export function fixTitle(f: CollisionFix, name: Names, order: readonly string[] = [], station = 'tool changer', list: readonly Collision[] = []): string {
  if (f.kind === 'reorder') {
    const next = f.order ?? []
    const last = next[next.length - 1]
    const rest = order.filter((id) => id !== last)
    return last !== undefined && next.slice(0, -1).every((id, i) => id === rest[i]) ? `Print ${name(last)} last` : 'Print the objects in a new order'
  }
  if (f.kind === 'by_layer') return 'Print by layer'
  if (f.kind === 'spread') return `Space the objects ${(f.mm ?? 0).toFixed(0)} mm wider`
  if (f.kind === 'raise_lift') return `Lift ${(f.mm ?? 0).toFixed(1)} mm on travels`
  if (f.kind === 'arrange') return 'Arrange the plate'
  if (zone(f, list)) return `Move ${name(f.objectId ?? '')} out of the zone`
  return `Move ${name(f.objectId ?? '')} out of the way to the ${station}`
}

/** What the fix does and clears. `total` is the number of collisions. */
export function fixDetail(f: CollisionFix, name: Names, total: number, station = 'tool changer', list: readonly Collision[] = []): string {
  // Without the list (older callers) every cleared item counts as a strike.
  const items = list.length ? list : Array.from({ length: total }, () => ({ severity: 'hit' }) as Collision)
  const c = clears(f, items)
  if (f.kind === 'reorder') return `Order: ${(f.order ?? []).map(name).join(', ')}. Clears ${c}.${leaves(f)}`
  if (f.kind === 'by_layer') {
    const moves = f.moves ?? 1
    return `Clears ${c}. Up to ${moves} more travel ${moves === 1 ? 'move' : 'moves'} per layer between the objects.`
  }
  if (f.kind === 'spread') return `Clears ${c}. Move them apart in Prepare, or arrange the plate with more space.`
  if (f.kind === 'raise_lift') return `Set Z hop to ${(f.mm ?? 0).toFixed(1)} mm. Clears ${c}.`
  if (f.kind === 'arrange') return `Clears ${c}. Places every object apart, so no paths cross.`
  const b = name(f.objectId ?? '')
  if (zone(f, list)) return `Place ${b} where the printer does not need the plate clear. Clears ${c}.`
  return `The toolhead crosses ${b} on its way to the ${station}. Place ${b} where the head does not pass, toward the front, or print it last.`
}
