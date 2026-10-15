// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const CODES: Record<string, ErrorCode> = {
  invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found',
  busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported',
}

/** Read the same concrete objects returned by live project edits. */
export function appObjectsTool(link: AppLinkCaller | undefined, appName: string): PilotTool<never> {
  return defineTool({
    name: 'app.objects', version: '1.0.0', source: 'command', permission: 'read',
    description: `Read the objects on the shown plate in ${appName}: ids and names, parts and filament slots, stored object and part overrides, locks and print inclusion, transforms and world bounds, volumes, paint counts, height ranges, brim points and history counts. Includes the bed shape. Use these object ids in live project commands and read again to verify the resulting state. Requires the app link; never reads a server-owned project.`,
    input: z.object({}).strict(),
    async run() {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
      try {
        const out = await link.call<{ bed: unknown; objects: Record<string, unknown>[] }>('plate.list', {})
        return { summary: `${out.objects.length} objects on the shown plate.`, output: out }
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed on it.`, 'not_configured', { appLink: code })
        throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
      }
    },
  }) as PilotTool<never>
}
