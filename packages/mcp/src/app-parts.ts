// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The parts inside an object open in the app: read them, clone one beside itself, put them in a new order, and rename
// one. Each edit is one undo step in the app and reads the parts back.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const object = z.string().min(1).describe('Object id or unique name on the shown plate')
const part = z.union([z.number().int().min(0), z.string().min(1)]).describe('A part of the object: its index from 0 (as app_parts lists them) or its name')

/** Shared input contracts for the command line, MCP and the open app. */
export const appPartInputs = {
  list: z.object({ object }).strict(),
  clone: z.object({ object, part }).strict(),
  order: z
    .object({
      object,
      order: z.array(z.number().int().min(0)).min(1).max(4000).optional().describe('The new order as old indices: part i after the call is part order[i] before it'),
      part: part.optional().describe('With to: the one part to move'),
      to: z.number().int().min(0).optional().describe('With part: its new index from 0'),
    })
    .strict(),
  rename: z.object({ object, part, name: z.string().describe('Its new name') }).strict(),
}

export interface AppParts {
  object: { id: string; name: string }
  plate: string
  parts: {
    index: number
    name: string
    /** The filament slot it prints with, 1-based, the object's own choice included. */
    slot: number
    triangles: number
    /** Paint layers it carries (color, seam, support, fuzzy). */
    painted: string[]
    /** Print settings of its own, by key. */
    settings: Record<string, unknown>
    /** Bounds in the object's own coordinates, mm. */
    boundsMm: { min: number[]; max: number[] } | null
  }[]
  /** The object's CAD history: how many steps and the last step's name, or null without one. */
  history: { steps: number; last: string | null } | null
  /** After a clone: the new part. */
  cloned?: { index: number; name: string }
  /** After a reorder or a rename: false when it was already that way. */
  changed?: boolean
}

const CODES: Record<string, ErrorCode> = {
  invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found',
  busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported',
}

export function appPartTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const call = async (method: string, args: Record<string, unknown>): Promise<AppParts> => {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
    try {
      return await link.call<AppParts>(method, args)
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed on it.`, 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  const commands = [
    ['list', 'app.parts', 'parts.list', "Read the parts of an open object in list order: index, name, filament slot, triangles, paint layers, print settings of its own and bounds in the object's coordinates, plus its CAD history length."],
    ['clone', 'app.part_clone', 'parts.clone', 'Clone one part inside its object, as Clone part in the object list: the copy is named like "Body 2", keeps the filament, print settings and paint, sits beside the original on X (its width plus 2 mm), goes last in the list and is picked. With a CAD history it is a step, so the timeline stays editable. One toolbar Undo. Returns the new part and the parts read back.'],
    ['order', 'app.parts_order', 'parts.order', 'Put the parts of an open object in a new order, by a full order of old indices or by moving one part to an index. Order is the list order only and does not change the print. Paint, filaments and print settings stay with their parts. With a CAD history it is a step. One toolbar Undo. Returns the parts read back.'],
    ['rename', 'app.part_rename', 'parts.rename', 'Rename one part of an open object, as Rename in the object list, such as a piece a cut or a file named "Hull top top": a name no other part has. Its filament, print settings and paint stay with it. With a CAD history it is a step. One toolbar Undo. Returns the parts read back.'],
  ] as const
  return commands.map(([input, name, method, description]) => defineTool({
    name, version: '1.0.0', source: 'command', permission: input === 'list' ? 'read' : 'slice',
    description: `${description} Needs the app link${input === 'list' ? '.' : ' and an edit grant.'}`,
    input: appPartInputs[input] as z.ZodType<Record<string, unknown>>,
    ...(input === 'list' ? {} : { approval: async (i: Record<string, unknown>) => ({ title: `Change the parts of ${i['object']}?`, lines: [], actions: [] }) }),
    async run(i) {
      const byOrder = i['order'] !== undefined && i['part'] === undefined && i['to'] === undefined
      const byMove = i['order'] === undefined && i['part'] !== undefined && i['to'] !== undefined
      if (input === 'order' && !byOrder && !byMove) throw new ToolInputError('Give order, or part with to', 'invalid_input')
      const out = await call(method, i)
      const what = out.cloned ? `cloned as ${out.cloned.name}, ` : input === 'order' ? (out.changed ? 'reordered, ' : 'already in that order, ') : input === 'rename' ? (out.changed ? 'renamed, ' : 'already called that, ') : ''
      return { summary: `${out.object.name}: ${what}${out.parts.length} parts read back.`, output: out }
    },
  })) as PilotTool<never>[]
}
