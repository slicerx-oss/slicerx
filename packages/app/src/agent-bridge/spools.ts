// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament section for an agent: every spool with what it holds, whether it is loaded and how many parts print
// on it, and the move a click on a spool makes (filament/pick.ts), so a client moves a part or the plate the way a
// person does and reads the result back.
import { activeMeta } from '../plate/plates'
import { currentTarget, moveToSpool, profileMaterial, spoolParts, spoolPicks, targetSlot, type SpoolTarget } from '../filament/pick'
import { slotMismatch } from '../filament/rail'
import { resolveSlots } from '../filament/slots'
import { get, type AppState } from '../state/store'
import { BridgeError } from './dom'

type Args = Record<string, unknown>

/** The spools as the Filament section shows them, and what a click would move now. */
export function spoolsView(s: AppState): Record<string, unknown> {
  const slots = resolveSlots(s)
  const meta = activeMeta(s)
  const parts = spoolParts(s.plate, meta)
  const mismatch = new Set(slotMismatch(s.printerSlots, slots).map((m) => m.slot))
  const target = currentTarget(s, null)
  const picks = spoolPicks.getState().why
  return {
    material: profileMaterial(s),
    fromPrinter: s.printerSlots.length > 0,
    target: { ...targetJson(target), slot: targetSlot(s, target) },
    spools: slots.map((r) => {
      const p = s.printerSlots[r.index - 1]
      const on = parts.get(r.index)
      return {
        slot: r.index,
        label: r.label,
        type: r.type,
        ...(r.family ? { family: r.family } : {}),
        brand: r.brand,
        color: r.color,
        source: r.source,
        loaded: Boolean(p && (p.material || p.color)),
        ...(p && !p.material && !p.color && r.source !== 'user' ? { empty: true } : {}),
        ...(r.remainingPct !== undefined ? { remainingPct: r.remainingPct } : {}),
        inUse: on?.parts ?? 0,
        parts: on?.names ?? [],
        ...(mismatch.has(r.index) ? { mismatch: true } : {}),
      }
    }),
    // why each object prints on its spool: picked by hand, or picked automatically by color, last used or material
    picks: Object.fromEntries(s.plate.filter((e) => picks[e.id]).map((e) => [e.id, picks[e.id]])),
  }
}

function targetJson(t: SpoolTarget): Record<string, unknown> {
  if (t.kind === 'objects') return { kind: 'objects', objects: [...t.ids], ...(t.part ? { part: t.part } : {}) }
  if (t.kind === 'filament') return { kind: 'filament', from: t.from }
  return { kind: 'plate' }
}

/** A spool by its label ("A3") or slot number. */
function slotOf(s: AppState, v: unknown, what: string): number {
  const slots = resolveSlots(s)
  const hit = typeof v === 'number' ? slots.find((r) => r.index === v) : typeof v === 'string' ? (slots.find((r) => r.label.toLowerCase() === v.trim().toLowerCase()) ?? slots.find((r) => String(r.index) === v.trim())) : undefined
  if (!hit) throw new BridgeError('not_found', `no ${what} ${String(v)}; the spools are ${slots.map((r) => r.label).join(', ')}`)
  return hit.index
}

/**
 * Moves an object (or one of its parts), the parts on one filament, or the whole plate to a spool, as a click on that
 * spool does. With none of object, from or plate, it moves what a click would: the selection, else the plate when it
 * uses one filament; a plate on two or more asks which.
 */
export function moveSpool(a: Args): Record<string, unknown> {
  const s = get()
  if (s.plate.length === 0) throw new BridgeError('not_ready', 'the plate is empty')
  const slot = slotOf(s, a['spool'], 'spool')
  let target: SpoolTarget
  if (typeof a['object'] === 'string' && a['object']) {
    const want = a['object']
    const e = s.plate.find((x) => x.id === want) ?? s.plate.find((x) => x.name === want)
    if (!e) throw new BridgeError('not_found', `no object ${want} on the plate`)
    const part = typeof a['part'] === 'string' && a['part'] ? a['part'] : undefined
    if (part && !e.handle.parts.some((p) => p.name === part)) throw new BridgeError('not_found', `${e.name} has no part ${part}; its parts are ${e.handle.parts.map((p) => p.name).join(', ')}`)
    target = { kind: 'objects', ids: [e.id], ...(part ? { part } : {}) }
  } else if (a['from'] !== undefined) target = { kind: 'filament', from: slotOf(s, a['from'], 'filament') }
  else if (a['plate'] === true) target = { kind: 'plate' }
  else {
    target = currentTarget(s, null)
    if (target.kind === 'filament') {
      const inUse = [...spoolParts(s.plate, activeMeta(s)).keys()].join(', ')
      throw new BridgeError('invalid_input', `the plate prints with filaments ${inUse}; give object, from or plate: true`)
    }
  }
  const moved = moveToSpool(target, slot)
  return { moved, spool: slot, ...spoolsView(get()) }
}
