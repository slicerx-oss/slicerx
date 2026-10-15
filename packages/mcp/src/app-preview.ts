// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

export interface AppPreview {
  sliced: boolean
  toolpaths: boolean
  camera: 'iso' | 'top' | 'front' | 'fit'
  toolhead: boolean
  gantry: boolean
  rightPane: 'open' | 'shut' | null
  drawer: 'open' | 'shut' | null
  layers?: number
  range?: [number, number]
  oneLayer?: boolean
  topZMm?: number
  colorMode?: 'feature' | 'tool' | 'speed' | 'flow' | 'layerTime'
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const layer = z.number().int().min(1)
const previewInput = z.object({
  layer: layer.optional().describe('Top visible layer, 1-based'),
  range: z.tuple([layer, layer]).optional().describe('First and last visible layers, inclusive and 1-based'),
  oneLayer: z.boolean().optional().describe('Show only the top visible layer; false restores the first layer to 1'),
  colorMode: z.enum(['feature', 'tool', 'speed', 'flow', 'layerTime']).optional(),
  camera: z.enum(['iso', 'top', 'front', 'fit']).optional(),
  toolhead: z.boolean().optional().describe('Show the toolhead in the preview'),
  gantry: z.boolean().optional().describe('Show the gantry in the preview'),
}).strict().refine((i) => Object.values(i).some((v) => v !== undefined), { message: 'Give at least one preview setting.' })
  .refine((i) => !i.range || i.range[0] <= i.range[1], { message: 'The first layer must not exceed the last layer.' })

function summary(p: AppPreview): string {
  if (!p.sliced || !p.range) return 'No slice preview is loaded.'
  return `Showing ${p.oneLayer ? `layer ${p.range[1]}` : `layers ${p.range[0]} to ${p.range[1]}`} of ${p.layers}, colored by ${p.colorMode}.`
}

export function appPreviewTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try {
      const out = await link.call<AppPreview>(method, args)
      return { summary: summary(out), output: out }
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.preview', version: '1.0.0', source: 'command', permission: 'read', input: z.object({}).strict(),
    description: `Read the slice preview in ${appName}: whether a slice is loaded and toolpaths are shown, layer count and visible range, top height in mm, colors, camera, toolhead and gantry switches, and visible panes. Layer fields are absent before a slice is loaded. Reads the live window through the app link.`,
    run: () => call('preview.get', {}),
  }), defineTool({
    name: 'app.preview_set', version: '1.0.0', source: 'command', permission: 'read', input: previewInput,
    description: `Change ${appName}'s visible slice layers, toolpath colors, camera, toolhead or gantry display and read the resulting state back. The app must be on Slice with no paint, brim or face tool active. Layer and color changes need a loaded slice. When combined, range is applied first, then layer, then oneLayer. Active playback is not paused, so visible layers may continue changing. These are view changes, not project edits or slicing; the existing read grant is sufficient.`,
    run: (i) => call('preview.set', i),
  })] as PilotTool<never>[]
}
