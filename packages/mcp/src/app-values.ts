// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Project expressions and step bindings live in the open app, with its printer and fit values.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const name = z.string().min(1).max(40)
const expression = z.string().trim().min(1).max(200)
export const appValueInputs = {
  'values.list': z.object({}),
  'values.set': z.object({ name, expression }),
  'values.remove': z.object({ name }),
  'values.bind': z.object({ design: z.string().min(1), step: z.union([z.number().int().min(1), z.string().min(1)]), expression: expression.nullable().describe('An expression to follow, or null to keep the current number without following a value') }),
}

export interface AppValuesResult {
  activePlate: string
  values: { name: string; expression: string; value?: number; error?: string }[]
  builtIns: Record<string, number>
  bindings: { plate: string; design: string; step: number; id: string; expression: string; value: number | null; resolved?: number; state: 'current' | 'pending' | 'broken'; error?: string }[]
  replayed: string[]
  issues: string[]
  applied?: boolean
}

const codes: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported', not_ready: 'busy', bad_request: 'not_supported' }

export function appValueTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const specs = [
    ['app.values', 'values.list', 'Read the open project\'s named values, expressions, resolved numbers or errors, built-in nozzle and clearance values, and step bindings on every plate. Pending bindings on other plates update when that plate is shown.'],
    ['app.value_set', 'values.set', 'Add or change a named value in the open project, using the same arithmetic and millimeter units as Named values for sizes. Replay affected steps on the shown plate and read back the values and bindings. An invalid expression stays stored, as in the app, and returns an error with applied:true and the resulting state. Other plates update when shown.'],
    ['app.value_remove', 'values.remove', 'Remove a named value from the open project. Refuse if any history step on any plate uses it directly. Read back the remaining values and bindings, including errors in expressions that depended on it.'],
    ['app.step_bind', 'values.bind', 'Bind a history step\'s main number to an expression in the open project, or pass expression:null to keep the number and stop following it. Give a design on the shown plate and a step index from 1 or step id. Replay the design and return the project values and bindings; read its geometry with slicerx_design_steps. Invalid expressions are refused before editing.'],
  ] as const
  return specs.map(([name, method, description]) => defineTool({
    name, version: '1.0.0', source: 'command', permission: method === 'values.list' ? 'read' : 'slice',
    description: `${description} Requires ${appName} open with the app link on; edits require its edit grant.`,
    input: appValueInputs[method] as z.ZodType<Record<string, unknown>>,
    async run(args) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (use --printers link).`, 'not_configured')
      let out: AppValuesResult
      try {
        out = await link.call<AppValuesResult>(method, args)
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(message, 'not_configured', { appLink: code })
        throw new ToolInputError(message, codes[code] ?? 'internal_error')
      }
      if (method !== 'values.list' && out.issues.length) throw new ToolInputError(`The project changed, but a value or step needs attention: ${out.issues[0]}`, 'invalid_input', { ...out })
      return { summary: `${out.values.length} named values; ${out.bindings.length} step bindings${out.replayed.length ? `; replayed ${out.replayed.length} designs` : ''}.`, output: out }
    },
  })) as PilotTool<never>[]
}
