// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

export const appUnitInputs = {
  get: z.object({}).strict(),
  set: z.object({
    length: z.enum(['mm', 'in']).optional(),
    precision: z.union([
      z.object({ decimals: z.number().int().min(0).max(4) }).strict(),
      z.object({ fraction: z.union([z.literal(16), z.literal(32), z.literal(64)]) }).strict(),
    ]).optional(),
  }).strict().refine((i) => i.length !== undefined || i.precision !== undefined, { message: 'Give length, precision or both' }),
}

export interface AppUnits {
  available: boolean
  length: 'mm' | 'in'
  mmDigits: number
  inchDigits: number
  inchFraction: number
  precision: { decimals: number } | { fraction: number }
  millimetersPerUnit: number
  dataUnit: 'mm'
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', refused: 'not_supported', busy: 'busy', read_only: 'not_supported' }
export function appUnitTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return (['get', 'set'] as const).map((action) => defineTool({
    name: action === 'get' ? 'app.units' : 'app.units_set', version: '1.0.0', source: 'command', permission: 'read',
    input: appUnitInputs[action] as z.ZodType<Record<string, unknown>>,
    description: `${action === 'get' ? 'Read Model display units and precision from Settings, including the remembered precision of each unit.' : 'Set Model display units (mm or in) and precision as in Settings. Precision is {decimals:n}: mm accepts 0-3 and inches 2-4, or {fraction:n} for inches to the nearest 1/16, 1/32 or 1/64. A unit switch preserves its remembered precision; a precision applies to the new unit or the current one. Invalid combinations refuse without changing anything. Returns the preferences read back.'} Needs ${appName}'s app link and the existing read grant. Changes only display and bare-number input interpretation; geometry, files, history, print settings and tool coordinates stay in mm. Adds no Undo step. The normal preference store remembers the choice.`,
    async run(input) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
      try {
        const output = await link.call<AppUnits>(`units.${action}`, input)
        return { summary: `Model display units: ${output.length}; stored geometry and tool coordinates: mm.`, output }
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
        if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
        throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
      }
    },
  })) as PilotTool<never>[]
}
