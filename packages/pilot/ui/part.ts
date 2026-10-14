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

/** A next step for a part: the chip's label and the exact request it sends. */
export interface FollowUp {
  id: string
  label: string
  request: string
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

/** What to offer next for a part. Each request names the part, so it reads on its own in the transcript. */
export function followUps(p: CreatedPart): FollowUp[] {
  const it = p.kind === 'part' ? p.name : `the ${p.kind}`
  const resize: FollowUp = { id: 'size', label: 'Change size', request: `Change the size of ${it}`, adds: false }
  if (p.kind === 'cylinder')
    return [
      { id: 'chamfer', label: 'Chamfer top edge', request: `Chamfer the top edge of ${it} by 1 mm`, adds: true },
      { id: 'hole', label: 'Center hole', request: `Add a hole through the center of ${it}`, adds: true },
      resize,
    ]
  if (p.kind === 'part') return [{ id: 'fillet', label: 'Fillet edges', request: `Fillet the outside edges of ${it} by 1 mm`, adds: true }, resize]
  return [
    { id: 'fillet', label: 'Fillet edges', request: `Fillet the edges of ${it} by 2 mm`, adds: true },
    { id: 'hole', label: 'Center hole', request: `Add a hole through the center of ${it}`, adds: true },
    resize,
  ]
}

/** The newest part the conversation's last turn made, once that turn has finished; null otherwise. */
export function lastPart(t: Transcript): CreatedPart | null {
  if (t.status === 'running') return null
  const turn = t.turns.at(-1)
  if (!turn) return null
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
