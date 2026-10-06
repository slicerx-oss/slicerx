// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The words for heimdall's collisions and fixes. The engine reports codes, numbers and object ids; every sentence the
// person reads is written here, in one place, ready for translation.
import type { Collision, CollisionFix } from '@slicerx/contracts'
import type { ToolChangerKind } from '@slicerx/viewport'

/** The plate's object names by id. */
export type Names = (id: string) => string

export function namesOf(plate: readonly { id: string; name: string }[]): Names {
  return (id) => plate.find((p) => p.id === id)?.name ?? 'an object'
}

/** What the head goes to during a tool change, by the changer's kind. */
export function stationOf(kind: ToolChangerKind | null | undefined): string {
  if (kind === 'hotend-rack') return 'hotend rack'
  if (kind === 'tool-rack' || kind === 'xl-dock') return 'tool dock'
  if (kind === 'lift-switch') return 'switch bay'
  return kind ? 'purge chute' : 'tool changer'
}

const mm = (v: number, digits = 1) => `${v.toFixed(digits)} mm`

/** One line naming what meets what. */
export function collisionTitle(c: Collision, name: Names, station = 'tool changer'): string {
  const b = name(c.hitId)
  if (c.severity === 'close') return `The toolhead passes close to ${b}`
  if (c.kind === 'gantry') return `The ${c.part === 'lid' ? 'frame' : 'gantry'} hits ${b}`
  if (c.kind === 'nozzle_travel_through_part') return `A travel runs through ${b}`
  if (c.kind === 'hotend') return c.part === 'nozzle' ? `The nozzle prints into ${b}` : `The toolhead hits ${b}`
  if (c.kind === 'tool_change') return `A tool change crosses ${b}`
  return `The ${station} meets ${b}`
}

/** Why it happens, with the numbers. */
export function collisionDetail(c: Collision, name: Names, station = 'tool changer'): string {
  const a = name(c.objectId)
  const b = name(c.hitId)
  const z = mm(c.at[2], 2)
  const r = c.lastLayer > c.layer ? `, layers ${c.layer + 1} to ${c.lastLayer + 1}` : `, on layer ${c.layer + 1}`
  const tall = `${b}, which stands ${mm(c.hitHeightMm)} tall${r}.`
  const limit = c.limitMm ?? 0
  if (c.severity === 'close')
    return `While ${a} prints, the nozzle comes within ${mm(Math.max(0, limit - c.depthMm))} of ${b}. The printer profile asks for ${limit.toFixed(0)} mm around the nozzle; the head's own shape clears ${b}, so this is the profile's margin, not a hit${r}.`
  if (c.kind === 'gantry' && c.part === 'lid') return `${b} is ${mm(c.hitHeightMm)} tall. Over the whole bed the printer clears ${mm(limit)} above the nozzle, so ${b} is in the way while ${a} prints${r}.`
  if (c.kind === 'gantry') return `${b} is ${mm(c.hitHeightMm)} tall. The gantry clears ${mm(limit)} above the nozzle, and it passes over ${b} while ${a} prints${r}.`
  if (c.kind === 'nozzle_travel_through_part') return `Moving across ${a} at ${z}, the nozzle passes through ${tall}`
  if (c.kind === 'hotend' && c.part === 'nozzle') return `A move of ${a} at ${z} passes through ${tall}`
  if (c.kind === 'hotend') return `While ${a} prints at ${z}, the toolhead reaches ${mm(Math.max(0.1, c.pushMm ?? 0))} into ${tall}`
  const piece = c.part === 'gantry' ? 'gantry' : c.part === 'nozzle' ? 'nozzle' : 'toolhead'
  if (c.kind === 'tool_change') return `On the way to the ${station} at ${z}, the ${piece} passes through ${tall}`
  return `At the ${station}, with ${a} at ${z}, the ${piece} reaches ${tall}`
}

/** How many of the list a fix clears. */
function clears(n: number, total: number): string {
  if (n === 1) return 'it'
  if (n === 2 && total === 2) return 'both'
  return n === total ? `all ${n}` : `${n} of ${total}`
}

/** The fix as a short instruction. `order` is the plate's current order of object ids. */
export function fixTitle(f: CollisionFix, name: Names, order: readonly string[] = [], station = 'tool changer'): string {
  if (f.kind === 'reorder') {
    const next = f.order ?? []
    const last = next[next.length - 1]
    const rest = order.filter((id) => id !== last)
    return last !== undefined && next.slice(0, -1).every((id, i) => id === rest[i]) ? `Print ${name(last)} last` : 'Print the objects in a new order'
  }
  if (f.kind === 'by_layer') return 'Print by layer'
  if (f.kind === 'spread') return `Space the objects ${(f.mm ?? 0).toFixed(0)} mm wider`
  if (f.kind === 'raise_lift') return `Lift ${(f.mm ?? 0).toFixed(1)} mm on travels`
  return `Move ${name(f.objectId ?? '')} out of the way to the ${station}`
}

/** What the fix does and clears. `total` is the number of collisions. */
export function fixDetail(f: CollisionFix, name: Names, total: number, station = 'tool changer'): string {
  const n = f.clears.length
  const strikes = n === 1 ? 'strike' : 'strikes'
  if (f.kind === 'reorder') return `Order: ${(f.order ?? []).map(name).join(', ')}. Clears ${clears(n, total)}.`
  if (f.kind === 'by_layer') {
    const moves = f.moves ?? 1
    return `Clears ${clears(n, total)}. Up to ${moves} more travel ${moves === 1 ? 'move' : 'moves'} per layer between the objects.`
  }
  if (f.kind === 'spread') return `Clears ${clears(n, total)} the toolhead ${strikes}. Move them apart in Prepare, or arrange the plate with more space.`
  if (f.kind === 'raise_lift') return `Set Z hop to ${(f.mm ?? 0).toFixed(1)} mm. Clears the travel ${strikes}.`
  const b = name(f.objectId ?? '')
  return `The toolhead crosses ${b} on its way to the ${station}. Place ${b} where the head does not pass, toward the front, or print it last.`
}
