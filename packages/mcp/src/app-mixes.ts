// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mixed filaments of the project open in the app (the Filament card's Mixes row), read and set through the app link.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { MAX_MIX_RATIO, MAX_MIXES, MIX_LOWEST_ID, MIX_TOP_ID } from '@slicerx/settings/mixed'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'
import { MAX_FILAMENTS } from './filaments'

const slot = z.number().int().min(1).max(MAX_FILAMENTS)
const ratioSide = z.number().int().min(1).max(MAX_MIX_RATIO)
export const appMixInputs = {
  get: z.object({}).strict(),
  set: z.object({
    mixes: z.array(z.object({
      id: z.number().int().min(MIX_LOWEST_ID).max(MIX_TOP_ID).describe(`The filament number objects, parts and paint use for the mix: past the loaded filaments, ${MIX_LOWEST_ID} to ${MIX_TOP_ID}`),
      name: z.string().trim().min(1).max(40),
      components: z.tuple([slot, slot]).describe('The two loaded filaments it mixes'),
      ratio: z.tuple([ratioSide, ratioSide]).describe('Layers of each per cycle'),
    }).strict()).max(MAX_MIXES).describe('The whole list; a mix it leaves out takes the parts and paint on it back to its first filament, as Delete mix does'),
  }).strict(),
}

export interface AppMixes {
  mixes: { id: number; name: string; components: [number, number]; ratio: [number, number] }[]
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', refused: 'not_supported', busy: 'busy', read_only: 'not_supported' }

export function appMixTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return (['get', 'set'] as const).map((action) => defineTool({
    name: action === 'get' ? 'app.mixed_filaments' : 'app.mixed_filaments_set', version: '1.0.0', source: 'command', permission: action === 'get' ? 'read' : 'slice',
    input: appMixInputs[action] as z.ZodType<Record<string, unknown>>,
    description: action === 'get'
      ? `Read the mixed filaments of the project open in ${appName}: each one's number, name, two loaded filaments and ratio in layers. A mix belongs to the project, so its number means the same mix on every plate; parts and color paint use it like a filament number.`
      : `Set the mixed filaments of the project open in ${appName} as a whole list (the Filament card's Mix editor): numbers past the loaded filaments, two different loaded filaments, each ratio side 1 to 20, four at most. A mix the list leaves out takes the parts and paint on it, on every plate, back to its first filament. One toolbar Undo step; returns the list read back.`,
    async run(input) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
      try {
        const output = await link.call<AppMixes>(`mixes.${action}`, input)
        return { summary: `${output.mixes.length} mixed ${output.mixes.length === 1 ? 'filament' : 'filaments'}`, output }
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
        if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
        throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
      }
    },
  })) as PilotTool<never>[]
}
