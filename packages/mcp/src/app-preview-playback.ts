// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const input = z.object({
  playing: z.boolean().optional().describe('Play or pause. Playing at the end restarts from zero.'),
  timeS: z.number().finite().min(0).optional().describe('Absolute print seconds, including startup and tool changes. Must not exceed durationS.'),
  speed: z.union([z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(5), z.literal(10), z.literal(50), z.literal(100)]).optional(),
  followNozzle: z.boolean().optional(),
}).strict().refine((i) => Object.values(i).some((v) => v !== undefined), { message: 'Give playing, timeS, speed or followNozzle.' })
interface Playback {
  available: boolean; sliced: boolean; playing: boolean; timeS: number | null; durationS: number | null
  speed: number; followNozzle: boolean; layer?: number; moveShare?: number
  toolChange?: { segment: number; seconds: number; fixed: number } | null; stopAtS?: number | null
}
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', busy: 'busy', not_ready: 'busy', denied: 'not_supported', read_only: 'not_supported' }

export function appPreviewPlaybackTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try {
      const output = await link.call<Playback>(method, args)
      return { summary: output.available ? `Preview ${output.playing ? 'playing' : 'paused'} at ${output.timeS} of ${output.durationS} seconds.` : 'The slice playback bar is not open.', output }
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
      if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.preview_playback', version: '1.0.0', source: 'command', permission: 'read', input: z.object({}).strict(),
    description: `Read ${appName}'s live slice playback: availability, playing, timeS, durationS, speed, followNozzle, layer, moveShare and current toolChange. Time includes startup and tool changes; unavailable time is null, not zero. Reads the same clock as the playback bar. Time advances while playing. Uses the existing app read grant.`,
    run: () => call('preview.playback', {}),
  }), defineTool({
    name: 'app.preview_playback_set', version: '1.0.0', source: 'command', permission: 'read', input,
    description: `Play, pause or seek ${appName}'s slice preview and set playback speed or nozzle following. Returns live read-back. Requires the sliced toolpath playback bar on Slice and no active paint, brim or face tool. Validates all fields before changing anything. Applies pause, preferences, seek, then play; playing at the end restarts. Seek alone preserves playing. Replacing or closing the bar pauses playback. View state only, with the existing read grant, no project edits or printer action.`,
    run: (i) => call('preview.playback_set', i),
  })] as PilotTool<never>[]
}
