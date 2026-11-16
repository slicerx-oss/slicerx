// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open app's feature filament table (the Color tab): which filament prints each feature for the plate or some of
// its objects, and what each feature printed with in the current slice.
import { defineTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const objects = z.array(z.string().min(1).max(200)).max(200).optional().describe('Object ids or names on the shown plate; omit for the plate')
export const appFeatureFilamentInputs = {
  'feature_filaments.get': z.object({ objects }).strict(),
  'feature_filaments.set': z
    .object({
      objects,
      filaments: z
        .record(z.string().min(1).max(60), z.number().int().min(0).max(255).nullable())
        .refine((r) => Object.keys(r).length > 0, { message: 'Give at least one feature.' })
        .describe('By feature (outerWall, innerWall, sparseInfill, internalSolid, topSurface, bottomSurface, support, supportInterface) or its setting key: 0 for the object\'s own filament, 1 and up for a filament slot, null to go back to the inherited value'),
    })
    .strict(),
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', denied: 'not_supported', read_only: 'not_supported' }

export function appFeatureFilamentTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  async function call(method: keyof typeof appFeatureFilamentInputs, args: Record<string, unknown>): Promise<ToolOutput> {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
    try {
      return await link.call<ToolOutput>(method, args)
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
      if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError(e instanceof Error ? e.message : String(e), 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  const readback = 'Returns the scope and one row per feature: feature, label, key, value (0 the object\'s own filament, null when the objects differ), source (plate, own or mixed), changed, and printedWith (the filament slots the feature printed with in the current slice, null with no current slice; a part reads null).'
  return [
    defineTool({
      name: 'app.feature_filaments',
      version: '1.0.0',
      source: 'settings',
      permission: 'read',
      input: appFeatureFilamentInputs['feature_filaments.get'],
      description: `Read ${appName}'s feature filament table (Color tab): which filament prints the outer and inner wall, sparse and solid infill, top and bottom surface, support and support interface, for the shown plate or the objects given. ${readback} Requires the open app with its link on.`,
      run: (i) => call('feature_filaments.get', i),
    }),
    defineTool({
      name: 'app.feature_filaments_set',
      version: '1.0.0',
      source: 'settings',
      permission: 'slice',
      input: appFeatureFilamentInputs['feature_filaments.set'],
      description: `Set which filament prints each feature in ${appName}, as the Color tab's feature filament table does: for the shown plate, or with objects for those objects (each source object once). Every row is checked before any change; a filament past the project's filaments is refused. ${readback} Requires the open app with its link on and its edit grant.`,
      run: (i) => call('feature_filaments.set', i),
    }),
  ] as PilotTool<never>[]
}
