// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const input = z.object({
  retractions: z.boolean().optional(), seams: z.boolean().optional(), lifts: z.boolean().optional().describe('Z hops'),
  wipes: z.boolean().optional(), toolChanges: z.boolean().optional(), pauses: z.boolean().optional(),
}).strict().refine((i) => Object.values(i).some((v) => v !== undefined), { message: 'Give at least one marker switch.' })
interface Markers {
  sliced: boolean
  toolpaths: boolean
  markers: { kind: string; label: string; shown: boolean; available: boolean; source: 'gcode' | 'preview'; count?: number }[]
}
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', busy: 'busy', not_ready: 'busy', refused: 'not_supported', denied: 'not_supported', read_only: 'not_supported' }

export function appPreviewMarkerTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try {
      const output = await link.call<Markers>(method, args)
      return { summary: `${output.markers.filter((m) => m.shown && m.available).length} preview marker kinds enabled.`, output }
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
      if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.preview_markers', version: '1.0.0', source: 'command', permission: 'read', input: z.object({}).strict(),
    description: `Read ${appName}'s preview legend marker switches: retractions, seams, lifts (Z hops), wipes, toolChanges and pauses. Reports each switch's shown preference and availability in the loaded slice. Counts are omitted until known; absent is not zero. G-code counts load asynchronously when a G-code marker is enabled. Reads live UI state through the app link.`,
    run: () => call('preview.markers', {}),
  }), defineTool({
    name: 'app.preview_markers_set', version: '1.0.0', source: 'command', permission: 'read', input,
    description: `Show or hide ${appName}'s preview legend markers and read the resulting switches back. Requires a loaded slice on Slice and no paint, brim or face tool. All switches validate before any change; unavailable markers cannot be enabled. Uses the legend's existing shared state. Counts may arrive later, so read app_preview_markers again. View preferences only, with the existing read grant and no project or print changes.`,
    run: (i) => call('preview.markers_set', i),
  })] as PilotTool<never>[]
}
