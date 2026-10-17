// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import type { AppLinkCaller } from './app-route'
import { brimEditInput, brimReadInput } from './brim-input'
import { ToolInputError, type ErrorCode } from './errors'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', denied: 'not_supported', read_only: 'not_supported' }
export function appBrimTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
    try {
      return await link.call<{ summary: string; output: unknown }>(method, args)
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed on it.`, 'not_configured')
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.brim_ears', version: '1.0.0', source: 'command', permission: 'read',
    description: `Read brim ears on the shown plate in ${appName}, optionally for one object: zero-based indices, local and bed coordinates in mm, world diameter, connectivity to the first layer, effective brim type, linked copies, generation defaults and a revision for edits. Reads stored ears even when painted brim is disabled. Requires the app link; never reads a server-owned project.`,
    input: brimReadInput,
    run: (i) => call('brim.get', i),
  }), defineTool({
    name: 'project.brim_ears', version: '1.0.0', source: 'command', permission: 'slice',
    description: `Edit brim ears for an explicit object on ${appName}'s shown plate. Read app_brim_ears first and pass its revision. Actions: add at x_mm/y_mm in bed coordinates; move one index; resize or remove indices; clear all; generate corners using max_angle and detection_mm. Diameter is 5 to 20 mm, rounded to 0.1 mm. Changes reach linked copies on other plates and form one toolbar Undo step. Returns actual state; reread app_brim_ears to verify. Does not change brim type: set brim_type to painted through project_set_overrides with --app or the app settings to print these ears. Refuses busy edits, locked linked objects, stale revisions and invalid indices.`,
    input: brimEditInput,
    run: (i) => call('brim.edit', i),
  })] as PilotTool<never>[]
}
