// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights in the running app: read, set and reset, as its layer height editor does.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'
import { layerProfileEditInput, layerProfileReadInput } from './layer-profile-input'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', denied: 'not_supported', read_only: 'not_supported' }

export function appLayerProfileTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
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
    name: 'app.layer_profile', version: '1.0.0', source: 'command', permission: 'read',
    description: `Read a plate's own layer heights in ${appName} (the shown plate, or plate by number or id): mode (what the plate slices with: calibration, resume, own, sleipnir or fixed; a calibration plate and a resume plan keep their own layers over a profile), the profile as [height above the bed mm, layer height mm] points or null, the printer's limits (min_mm, max_mm, first_layer_mm), the plate's top_mm, the layer count the profile gives, the fixed layer_height_mm and a revision. Requires the app link; never reads a server-owned project.`,
    input: layerProfileReadInput,
    run: (i) => call('layers.profile.get', i),
  }), defineTool({
    name: 'project.layer_profile', version: '1.0.0', source: 'command', permission: 'slice',
    description: `Set or reset a plate's own layer heights in ${appName}. set takes points, [height above the bed mm, layer height mm] pairs; the layer height is straight between points and flat past the ends, and the first layer keeps the printer's first layer height. The plate then slices at those layers in place of sleipnir and the fixed layer height. Heights outside the printer's limits (read them with app_layer_profile) are refused. reset clears the profile so the plate slices as before. Pass the revision app_layer_profile read to refuse an edit after another change (busy). Refused with busy while the app loads, slices or edits. One toolbar Undo step; returns the profile read back.`,
    input: layerProfileEditInput,
    run: (i) => call('layers.profile.edit', i),
  })] as PilotTool<never>[]
}
