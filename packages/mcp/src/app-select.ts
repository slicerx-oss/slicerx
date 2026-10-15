// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's Select Other, through the app link: everything under one spot of the open app's 3D view (the edge a click
// there picks first, then the faces front to back, then the bodies) and picking one of them by its index, as a person
// does from the list a held pointer opens. A pick changes what the window has selected, never the project, so both
// tools read. Each answer carries the list again, and a pick carries the selection read back.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** One thing under the spot, as the app answers (packages/app plate/select-other-pick.ts). */
export interface SelectCandidate {
  index: number
  kind: 'edge' | 'face' | 'body'
  /** Plain words: "Top face", "Round edge", "Body". */
  label: string
  /** The object's name. */
  object: string
  objectId: string
  part?: number
  triangle?: number
  round?: boolean
  pointMm: number[]
  depthMm: number
}

export interface SelectUnder {
  /** The spot, view pixels from the view's top left corner. */
  at: { x: number; y: number }
  view: { width: number; height: number }
  candidates: SelectCandidate[]
}

export interface SelectPicked extends SelectUnder {
  picked: SelectCandidate
  selection: { readout: string; selectedIds: string[]; picks: { kind: 'face' | 'edge'; objectId: string; part: number; triangle: number; round?: boolean }[] }
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_supported', not_ready: 'not_configured', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call<T>(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<T> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<T>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its view cannot be picked in.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const spot = {
  x: z.number().min(0).optional().describe("Pixels from the left edge of the app's 3D view"),
  y: z.number().min(0).optional().describe("Pixels from the top edge of the app's 3D view"),
  pointMm: z.tuple([z.number(), z.number(), z.number()]).optional().describe('A bed point in mm (X, Y, Z up), put on screen with the view as it is'),
}

const oneSpot = (i: { x?: number | undefined; y?: number | undefined; pointMm?: unknown }) => (i.pointMm !== undefined ? i.x === undefined && i.y === undefined : i.x !== undefined && i.y !== undefined)
const SPOT_MESSAGE = 'Give x and y, or pointMm, not both.'

function spotArgs(i: { x?: number | undefined; y?: number | undefined; pointMm?: [number, number, number] | undefined }): Record<string, unknown> {
  return i.pointMm ? { pointMm: i.pointMm } : { x: i.x, y: i.y }
}

const list = (c: readonly SelectCandidate[]) => c.map((x) => `${x.index}: ${x.label} on ${x.object}`).join('; ')

export function appSelectTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const under = defineTool({
    name: 'app.select_under',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `List everything under one spot of ${appName}'s Model view, in the order its Select Other list shows: the edge a click there picks first (one within 6 px of the spot), then every face front to back, then every body front to back. The spot is x and y in view pixels from the view's top left corner, or pointMm, a bed point in mm. Each candidate has an index for slicerx_app_select_other, a kind (edge, face or body), a plain label (Top face, Round edge, Body), the object, and where the ray meets it. Model must be open with no tool open. Reads only.`,
    input: z.object(spot).refine(oneSpot, { message: SPOT_MESSAGE }),
    async run(i) {
      const out = await call<SelectUnder>(link, appName, 'select.under', spotArgs(i))
      return { summary: out.candidates.length ? `${out.candidates.length} under the spot: ${list(out.candidates)}` : 'Nothing under that spot.', output: out }
    },
  })
  const other = defineTool({
    name: 'app.select_other',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Select one of the things under a spot of ${appName}'s Model view by its index from slicerx_app_select_under, as a person picks it from the Select Other list: a face or an edge becomes the pick on its object, a body selects the whole object. Changes only what is selected, never the project. Returns the candidate picked, the list at the spot again, and the selection read back (the selection pill's words, the selected objects and the face or edge picks).`,
    input: z.object({ ...spot, index: z.number().int().min(0).describe('The candidate to pick, from slicerx_app_select_under') }).refine(oneSpot, { message: SPOT_MESSAGE }),
    async run(i) {
      const out = await call<SelectPicked>(link, appName, 'select.other', { ...spotArgs(i), index: i.index })
      return { summary: `Selected ${out.picked.label} on ${out.picked.object}. The selection reads: ${out.selection.readout}.`, output: out }
    },
  })
  return [under, other] as PilotTool<never>[]
}
