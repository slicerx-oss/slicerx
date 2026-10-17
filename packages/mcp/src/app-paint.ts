// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import type { AppLinkCaller } from './app-route'
import { appPaintReadInput, appPaintPreviewInput, appPaintApplyInput, appPaintClearInput } from './app-paint-input'
import { ToolInputError, type ErrorCode } from './errors'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', denied: 'not_supported', read_only: 'not_supported' }
export function appPaintTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: string, args: Record<string, unknown>) {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try { return await link.call<{ summary: string; output: unknown }>(method, args) }
    catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured')
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  return [defineTool({
    name: 'app.paint', version: '1.0.0', source: 'command', permission: 'read', input: appPaintReadInput,
    description: `Read an object's color, seam, support or fuzzy paint in ${appName}'s shown plate. Returns per-part states, areas in mm2, connected regions in bed coordinates, available color slot count and a revision. Use an object id from app_history. Reads the live project, including viewport brush strokes.`,
    run: (i) => call('paint.get', i),
  }), defineTool({
    name: 'app.paint_preview', version: '1.0.0', source: 'command', permission: 'read', input: appPaintPreviewInput,
    description: `Preview paint on an object in ${appName}'s shown plate without changing it. Target a whole part, direction, height band, seeded smart fill or bucket, or replace a state. Coordinates are bed coordinates in mm. A seed on a multipart object requires part. Returns a preview id, affected area and resulting paint regions. Color states are existing filament slots; seam/support use 1 or 2; fuzzy uses 1; 0 clears. Apply through app_paint_apply with the same client. Copies keep independent paint, as with the brush.`,
    run: (i) => call('paint.preview', i),
  }), defineTool({
    name: 'app.paint_apply', version: '1.0.0', source: 'command', permission: 'slice', input: appPaintApplyInput,
    description: `Apply this client's live paint preview in ${appName}. Refuses if the project changed or another plate is shown. One toolbar Undo step, including enabling painted fuzzy skin when needed. Returns actual paint read-back. Refuses locked objects and active edits or slices.`,
    run: (i) => call('paint.apply', i),
  }), defineTool({
    name: 'app.paint_clear', version: '1.0.0', source: 'command', permission: 'slice', input: appPaintClearInput,
    description: `Clear one object's paint layer on ${appName}'s shown plate, as Clear layer in the paint panel. Pass the revision from app_paint. Other layers and copies are preserved. Returns read-back and changed; a change is one toolbar Undo step.`,
    run: (i) => call('paint.clear', i),
  })] as PilotTool<never>[]
}
