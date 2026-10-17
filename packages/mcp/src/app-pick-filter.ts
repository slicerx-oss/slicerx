// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

interface PickFilter {
  available: boolean
  pickFilter: ('object' | 'face' | 'edge')[]
  primary: string | null
  objects: { id: string; name: string | null }[]
  picks: { kind: 'face' | 'edge'; objectId: string; part: number; triangle: number; pointMm: number[]; round?: boolean }[]
  edgeWinsPx?: number
}
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', busy: 'busy', denied: 'not_supported', read_only: 'not_supported' }

export function appPickFilterTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try {
      const output = await link.call<PickFilter>(method, args)
      return { summary: `Model pick filter: ${output.pickFilter.map((k) => k === 'object' ? 'body' : k).join(', ')}.`, output }
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
      if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.pick_filter', version: '1.0.0', source: 'command', permission: 'read', input: z.object({}).strict(),
    description: `Read ${appName}'s Model pick filter and selected bodies, faces and edges. pickFilter uses object (the Body button), face and edge. available says whether the filter can change now. Includes primary, objects, picks and edgeWinsPx when Face mode lets nearby edges win. Point coordinates are rounded to two decimals; triangle and part are transient mesh indices, not stable CAD references. Uses the existing app read grant.`,
    run: () => call('select.filter', {}),
  }), defineTool({
    name: 'app.pick_filter_set', version: '1.0.0', source: 'command', permission: 'read',
    input: z.object({ kind: z.enum(['object', 'face', 'edge']).describe('object is the Body button; face and edge are Face and Edge only.'), mode: z.enum(['only', 'toggle']).optional().describe('only (default) picks just this kind. toggle adds or drops it, keeping at least one kind.') }).strict(),
    description: `Change ${appName}'s Model pick filter through the same command as its Body, Face and Edge only buttons. Returns the filter and selection read back. Requires Model or the modeling view in mimir with no active object or viewport tool. Drops picked faces or edges excluded by the new filter while retaining the body selection. Does not pick geometry, open a tool, edit the project or move the camera. Uses the existing app read grant.`,
    run: (i) => call('select.filter_set', i),
  })] as PilotTool<never>[]
}
