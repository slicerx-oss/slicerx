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
  /** Built step by step in a design: the card follows the turn's step rows, which stay. */
  built?: true
  /** A design the turn changed but did not start: the card says it was updated, not created. */
  updated?: true
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
/** Design steps that change the design; each returns the design's summary. Reads (steps, measure, info) are left out. */
const BUILDERS: ReadonlySet<string> = new Set([
  'design.edit_step',
  'design.undo',
  'design.redo',
  'design.roll',
  'geom.extrude',
  'geom.revolve',
  'geom.push_pull',
  'geom.boolean',
  'geom.fillet',
  'geom.chamfer',
  'geom.hole',
  'geom.shell',
  'geom.cut',
  'geom.split',
  'geom.mirror',
  'geom.array',
  'geom.repair',
  'geom.hollow',
  'geom.emboss',
  'geom.build',
  'geom.subtract',
])

/** The design an ok design step changed, or null for any other call. */
function changedDesign(row: ToolRowModel): string | null {
  if (row.state !== 'ok' || !BUILDERS.has(row.tool)) return null
  const o = row.output as Record<string, unknown> | null | undefined
  return o && typeof o === 'object' && typeof o['design'] === 'string' && o['design'] ? o['design'] : null
}

/** The design an ok design.new started, or null. */
function startedDesign(row: ToolRowModel): string | null {
  if (row.state !== 'ok' || row.tool !== 'design.new') return null
  const o = row.output as Record<string, unknown> | null | undefined
  return o && typeof o === 'object' && typeof o['design'] === 'string' && o['design'] ? o['design'] : null
}

const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

/** The part a finished tool call created, or null when the call made none. */
export function createdPart(row: ToolRowModel): CreatedPart | null {
  if (row.state !== 'ok' || !MAKERS.has(row.tool)) return null
  const o = row.output as Record<string, unknown> | null | undefined
  if (!o || typeof o !== 'object' || typeof o['objectId'] !== 'string') return null
  const size = o['sizeMm']
  if (!triple(size)) return null
  const kind = typeof o['kind'] === 'string' && KINDS.has(o['kind']) ? (o['kind'] as PartKind) : 'part'
  const name = typeof o['name'] === 'string' && o['name'] ? o['name'] : o['objectId']
  return { id: o['objectId'], name, kind, sizeMm: [size[0], size[1], size[2]] }
}

/**
 * The design a finished design step left, read from the design summary it returned: the design id (the object's id
 * on the plate), its name and its size. Null for a read, a failed step or a design with nothing in it yet.
 */
export function builtPart(row: ToolRowModel): CreatedPart | null {
  const design = changedDesign(row)
  if (!design) return null
  const o = row.output as Record<string, unknown>
  const size = o['sizeMm']
  if (!triple(size)) return null
  const name = typeof o['name'] === 'string' && o['name'] ? o['name'] : design
  return { id: design, name, kind: 'part', sizeMm: [size[0], size[1], size[2]], built: true }
}

const WORD: Record<PartKind, string> = { cube: 'Cube', box: 'Box', cylinder: 'Cylinder', part: 'Part' }

const mm = (v: number): string => String(Math.round(v * 10) / 10)

/** "20 x 20 x 20 mm". */
export function partSize(p: CreatedPart): string {
  return `${p.sizeMm.map(mm).join(' x ')} mm`
}

/** The card's title: "Cube created", or "Box with lid updated" for a design the turn changed but did not start. */
export function partTitle(p: CreatedPart): string {
  return p.updated ? `${p.name} updated` : `${WORD[p.kind]} created`
}

/** The card's subtitle: "Cube 20 x 20 x 20 mm", or the part's own name for anything that is not a plain solid. */
export function partLine(p: CreatedPart): string {
  return `${p.kind === 'part' ? p.name : WORD[p.kind]} ${partSize(p)}`
}

const half = (v: number): number => Math.round(v * 2) / 2

/** "the 20 mm cube": the part by its own name, so a request reads on its own in the transcript. */
const the = (p: CreatedPart): string => `the ${p.name}`

/** Whether the toolset the chat runs with has a tool, by name. */
export type CanTool = (tool: string) => boolean

/** The tools a next step needs: a chip shows only when the chat's toolset has one of them. */
const NEEDS: Readonly<Record<string, readonly string[]>> = {
  fillet: ['geom.fillet'],
  chamfer: ['geom.chamfer'],
  hole: ['geom.hole'],
  size: ['design.new', 'text_to_part'],
}

/**
 * What to offer next for a part, among the steps the toolset can do (`can`; without it, none). A step that acts at once
 * shows its value in the label ("Fillet edges, 2 mm"); a step that needs a value (the size) asks for it before anything
 * is sent.
 */
export function followUps(p: CreatedPart, can: CanTool = () => false): FollowUp[] {
  const it = the(p)
  const small = Math.min(...p.sizeMm)
  const across = Math.min(p.sizeMm[0], p.sizeMm[1])
  const round = Math.max(0.5, Math.min(2, half(small / 8)))
  const hole = Math.max(1, Math.min(20, half(across / 4)))
  const resize: FollowUp = { id: 'size', label: 'Change size', asks: 'size', adds: false }
  const holeStep: FollowUp = { id: 'hole', label: `Center hole, ${mm(hole)} mm`, request: `Add a ${mm(hole)} mm hole through the center of ${it}`, adds: true }
  const all =
    p.kind === 'cylinder'
      ? [{ id: 'chamfer', label: `Chamfer top edge, ${mm(round / 2)} mm`, request: `Chamfer the top edge of ${it} by ${mm(round / 2)} mm`, adds: true }, holeStep, resize]
      : p.kind === 'part'
        ? [{ id: 'fillet', label: `Fillet edges, ${mm(round / 2)} mm`, request: `Fillet the outside edges of ${it} by ${mm(round / 2)} mm`, adds: true }, resize]
        : [{ id: 'fillet', label: `Fillet edges, ${mm(round)} mm`, request: `Fillet the edges of ${it} by ${mm(round)} mm`, adds: true }, holeStep, resize]
  return all.filter((f) => (NEEDS[f.id] ?? []).some(can))
}

/** The request a new size sends: "Change the size of the 20 mm cube to 30 x 20 x 20 mm". */
export function sizeRequest(p: CreatedPart, size: readonly [number, number, number]): string {
  return `Change the size of ${the(p)} to ${size.map(mm).join(' x ')} mm`
}

/**
 * The newest part a turn made, or null when it made none: a part a single call made, or the design the turn built
 * step by step, as its newest step left it. A turn of many steps on one design gives that one design, not a part per
 * step. A design the turn did not start with design.new is marked updated. A design whose newest step left it empty
 * (an undo of its only step) gives no card.
 */
export function turnPart(turn: Transcript['turns'][number]): CreatedPart | null {
  const rows = turn.blocks.flatMap((b) => (b.kind === 'tools' ? b.rows : []))
  const emptied = new Set<string>()
  for (let k = rows.length - 1; k >= 0; k--) {
    const row = rows[k]!
    const made = createdPart(row)
    if (made) return made
    const design = changedDesign(row)
    if (!design || emptied.has(design)) continue
    const p = builtPart(row)
    if (!p) {
      emptied.add(design)
      continue
    }
    return rows.slice(0, k).some((r) => startedDesign(r) === design) ? p : { ...p, updated: true }
  }
  return null
}

/** True when one of the turn's calls made a part, so the turn shows a part card. */
export function madePart(turn: Transcript['turns'][number]): boolean {
  return turnPart(turn) !== null
}
