// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// The part a reply made, read from the tool's own result (the same output a client gets), and the next steps offered for it.
import type { ToolRowModel, Transcript } from './reduce'

export type PartKind = 'cube' | 'box' | 'cylinder' | 'part'

export interface CreatedPart {
  /** The object id in the project. */
  id: string
  name: string
  kind: PartKind
  sizeMm: [number, number, number]
}

/** A next step for a part: the chip's label and the exact request it sends, or the value it asks for first. */
export interface FollowUp {
  id: string
  label: string
  /** The request sent as typed; absent when the step asks for a value first. */
  request?: string
  /** The value the chip collects before anything is sent. */
  asks?: 'size'
  /** Adds something to the part (drawn with a plus). */
  adds: boolean
}

/** Tools whose result is a new part on the plate. */
const MAKERS: ReadonlySet<string> = new Set(['text_to_part'])
const KINDS: ReadonlySet<string> = new Set(['cube', 'box', 'cylinder', 'part'])

/** The part a finished tool call created, or null when the call made none. */
export function createdPart(row: ToolRowModel): CreatedPart | null {
  if (row.state !== 'ok' || !MAKERS.has(row.tool)) return null
  const o = row.output as Record<string, unknown> | null | undefined
  if (!o || typeof o !== 'object' || typeof o['objectId'] !== 'string') return null
  const size = o['sizeMm']
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const kind = typeof o['kind'] === 'string' && KINDS.has(o['kind']) ? (o['kind'] as PartKind) : 'part'
  const name = typeof o['name'] === 'string' && o['name'] ? o['name'] : o['objectId']
  return { id: o['objectId'], name, kind, sizeMm: [size[0], size[1], size[2]] }
}

const WORD: Record<PartKind, string> = { cube: 'Cube', box: 'Box', cylinder: 'Cylinder', part: 'Part' }

const mm = (v: number): string => String(Math.round(v * 10) / 10)

/** "20 x 20 x 20 mm". */
export function partSize(p: CreatedPart): string {
  return `${p.sizeMm.map(mm).join(' x ')} mm`
}

/** The card's title: "Cube created". */
export function partTitle(p: CreatedPart): string {
  return `${WORD[p.kind]} created`
}

/** The card's subtitle: "Cube 20 x 20 x 20 mm", or the part's own name for anything that is not a plain solid. */
export function partLine(p: CreatedPart): string {
  return `${p.kind === 'part' ? p.name : WORD[p.kind]} ${partSize(p)}`
}

const half = (v: number): number => Math.round(v * 2) / 2

/** "the 20 mm cube": the part by its own name, so a request reads on its own in the transcript. */
const the = (p: CreatedPart): string => `the ${p.name}`

/**
 * What to offer next for a part. A step that acts at once shows its value in the label ("Fillet edges, 2 mm"); a
 * step that needs a value (the size) asks for it before anything is sent.
 */
export function followUps(p: CreatedPart): FollowUp[] {
  const it = the(p)
  const small = Math.min(...p.sizeMm)
  const across = Math.min(p.sizeMm[0], p.sizeMm[1])
  const round = Math.max(0.5, Math.min(2, half(small / 8)))
  const hole = Math.max(1, Math.min(20, half(across / 4)))
  const resize: FollowUp = { id: 'size', label: 'Change size', asks: 'size', adds: false }
  const holeStep: FollowUp = { id: 'hole', label: `Center hole, ${mm(hole)} mm`, request: `Add a ${mm(hole)} mm hole through the center of ${it}`, adds: true }
  if (p.kind === 'cylinder') return [{ id: 'chamfer', label: `Chamfer top edge, ${mm(round / 2)} mm`, request: `Chamfer the top edge of ${it} by ${mm(round / 2)} mm`, adds: true }, holeStep, resize]
  if (p.kind === 'part') return [{ id: 'fillet', label: `Fillet edges, ${mm(round / 2)} mm`, request: `Fillet the outside edges of ${it} by ${mm(round / 2)} mm`, adds: true }, resize]
  return [{ id: 'fillet', label: `Fillet edges, ${mm(round)} mm`, request: `Fillet the edges of ${it} by ${mm(round)} mm`, adds: true }, holeStep, resize]
}

/** The request a new size sends: "Change the size of the 20 mm cube to 30 x 20 x 20 mm". */
export function sizeRequest(p: CreatedPart, size: readonly [number, number, number]): string {
  return `Change the size of ${the(p)} to ${size.map(mm).join(' x ')} mm`
}

/** The newest part a turn made, or null when it made none. */
export function turnPart(turn: Transcript['turns'][number]): CreatedPart | null {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i]!
    if (b.kind !== 'tools') continue
    for (let k = b.rows.length - 1; k >= 0; k--) {
      const p = createdPart(b.rows[k]!)
      if (p) return p
    }
  }
  return null
}

/** True when one of the turn's calls made a part, so the turn shows a part card. */
export function madePart(turn: Transcript['turns'][number]): boolean {
  return turnPart(turn) !== null
}
