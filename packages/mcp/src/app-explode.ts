// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open app's exploded view, through the app link: the Spread control over the view that draws the parts of the
// selected objects moved apart. Display only, like the slice preview, so both tools read: the project, the slice and
// the undo history never see it. Each answer is the state read back, with the offsets the view draws the parts at.
import { EXPLODE_AXES, type ExplodeAxis } from '@slicerx/contracts/explode'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** The exploded view as the app reads it back (packages/app app-link/explode.ts). */
export interface AppExplode {
  spread: number
  axis: ExplodeAxis
  /** The selected objects with 2 parts or more: the ones the spread moves apart. */
  targets: { id: string; name: string; parts: number }[]
  /** Whether the view draws the spread now: false while the slice's toolpaths stand in for the models or an edit tool is open. */
  shown: boolean
  /** An edit tool is open and keeps the parts where they print; explode_set refuses a spread until it ends. */
  held: boolean
  /** Offsets the view draws each spread object's parts at, bed mm, part 0 first; null while no 3D view is up. */
  drawn: Record<string, [number, number, number][]> | null
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppExplode> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppExplode>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its exploded view cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const AXIS_WORDS: Record<ExplodeAxis, string> = { radial: 'radially', x: 'along X', y: 'along Y', z: 'along Z' }

export function explodeSummary(e: AppExplode): string {
  if (!e.targets.length) return `Nothing to spread: no selected object has 2 parts or more (axis ${e.axis}).`
  const names = e.targets.map((t) => `${t.name} (${t.parts} parts)`).join(', ')
  if (e.spread > 0) return `Spread ${e.spread} percent ${AXIS_WORDS[e.axis]}: ${names}.${e.shown ? '' : ' Not drawn now: the view shows the toolpaths or an edit tool is open.'}`
  return `Drawn whole (spread 0, axis ${e.axis}): ${names}.${e.held ? ' An edit tool is open, so the parts stay where they print.' : ''}`
}

export function appExplodeTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const get = defineTool({
    name: 'app.explode',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read ${appName}'s exploded view, the Spread control over the 3D view: spread (0 to 100 percent), axis (radial, x, y or z), targets (the selected objects with 2 parts or more, which it moves apart; their modifier and other volumes stay with them), shown (whether the view draws it now), held (an edit tool keeps the parts where they print) and drawn (the offsets the view draws each target's parts at, bed mm, part 0 first; null while no 3D view is up). Display only: it never changes the project, the slice or the undo history, and it goes back to 0 when the selection changes. Reads through the app link.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'explode.get', {})
      return { summary: explodeSummary(out), output: out }
    },
  })
  const set = defineTool({
    name: 'app.explode_set',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Set ${appName}'s exploded view the way the person does with the Spread control over the 3D view: spread (0 to 100 percent) moves the parts of the selected objects with 2 parts or more apart, and axis picks the direction (radial: out from the middle; x, y: along that bed axis in order; z: the lowest part stays and the others rise). Select the object first (slicerx_app_ui_select). Refused (busy) while the view shows the slice toolpaths or an edit tool is open, since editing puts the parts back where they print. Display only: the project, the slice and the undo history never see it. Returns the exploded view read back, with the offsets the view draws.`,
    input: z
      .object({
        spread: z.number().min(0).max(100).optional().describe('How far apart the parts are drawn, 0 to 100 percent'),
        axis: z.enum(EXPLODE_AXES as unknown as ['radial', 'x', 'y', 'z']).optional().describe('radial, x, y or z'),
      })
      .refine((i) => i.spread !== undefined || i.axis !== undefined, { message: 'Give spread, axis or both.' }),
    async run(i) {
      const out = await call(link, appName, 'explode.set', { ...(i.spread !== undefined ? { spread: i.spread } : {}), ...(i.axis ? { axis: i.axis } : {}) })
      return { summary: explodeSummary(out), output: out }
    },
  })
  return [get, set] as PilotTool<never>[]
}
