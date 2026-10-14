// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plates of the project open in the app, through the app link: each plate's number, name, objects and slice state,
// and showing one of them the way the app's plate picker does (a plate by number, or the next or previous). Showing a
// plate changes only what the window shows, never the project, so both tools read. Each answer is the plates read back.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** One plate as the app reads it back (packages/app app-link/methods.ts, plates.list). */
export interface AppPlate {
  number: number
  id: string
  name: string
  objects: number
  slice: 'empty' | 'not-sliced' | 'slicing' | 'sliced' | 'stale'
  shown: boolean
}
export interface AppPlates {
  shown: number
  count: number
  plates: AppPlate[]
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppPlates> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppPlates>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its plates cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const SLICE_WORDS: Record<AppPlate['slice'], string> = { empty: 'empty', 'not-sliced': 'not sliced', slicing: 'slicing', sliced: 'sliced', stale: 'sliced before a settings change' }

function summary(p: AppPlates): string {
  const cur = p.plates.find((x) => x.shown)
  const notSliced = p.plates.filter((x) => x.slice === 'not-sliced' || x.slice === 'stale').length
  const name = cur && cur.name !== `Plate ${cur.number}` ? ` (${cur.name})` : ''
  return `Plate ${p.shown}${name} of ${p.count} is shown${cur ? `, ${SLICE_WORDS[cur.slice]}` : ''}; ${notSliced} ${notSliced === 1 ? 'plate needs' : 'plates need'} a slice.`
}

export function appPlateTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const list = defineTool({
    name: 'app.plates',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `List the plates of the project open in ${appName}, in order: each plate's number (from 1), id, name, object count and slice state (empty, not-sliced, slicing, sliced, or stale when the settings changed after the slice), and which plate the window shows. Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'plates.list', {})
      return { summary: summary(out), output: out }
    },
  })
  const show = defineTool({
    name: 'app.plate_show',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Show one plate of the project open in ${appName}, as its plate picker does: plate (a number from 1, or an id from slicerx_app_plates), or step: next or previous (stepping stops at the first and last plate). It changes only what the window shows, never the project, and answers busy while the person is in Model or using a paint, brim or face tool. Returns the plates read back, with the one now shown.`,
    input: z
      .object({
        plate: z.union([z.number().int().min(1), z.string().min(1).max(80)]).optional().describe('The plate to show: its number from 1, or its id'),
        step: z.enum(['next', 'previous']).optional().describe('Show the next or the previous plate instead'),
      })
      .refine((i) => (i.plate === undefined) !== (i.step === undefined), { message: 'Give plate or step, not both.' }),
    async run(i) {
      const out = await call(link, appName, 'plates.show', i.plate !== undefined ? { plate: i.plate } : { step: i.step })
      return { summary: summary(out), output: out }
    },
  })
  return [list, show] as PilotTool<never>[]
}
