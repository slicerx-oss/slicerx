// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'
import { cutInput } from './cut-input'

const codes: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', read_only: 'not_supported', denied: 'not_supported' }

export function appCutTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return [defineTool({
    name: 'project.cut', version: '1.0.0', source: 'command', permission: 'slice',
    description: `Cut one object on ${appName}'s shown plate into separate objects, as Prepare's Cut tool does. Keep both halves, above or below the plane; optional pins, dowels or dovetails align the printed pieces. Places pieces on the bed, preserves print settings and spatial modifiers, and returns their ids, bounds, print state, actual connector reports and warnings. Triangle paint and measurements attached to replaced geometry are cleared with warnings; one toolbar Undo restores the original. Requires the open app and an edit grant. This differs from geom_cut on a design, which records a CAD step and creates parts.`,
    input: cutInput,
    async run(args) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (use --printers link).`, 'not_configured')
      try { return await link.call<ToolOutput>('project.cut', args) } catch (error) {
        const code = String((error as { code?: unknown })?.code ?? '')
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`Open ${appName} and allow this client on its app link before cutting.`, 'not_configured')
        throw new ToolInputError(error instanceof Error ? error.message : String(error), codes[code] ?? 'internal_error')
      }
    },
  })] as PilotTool<never>[]
}
