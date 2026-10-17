// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const pick = z.object({ object: z.string().min(1), part: z.number().int().nonnegative(), triangle: z.number().int().nonnegative(), at: vec3 }).strict()
export const appDimensionInputs = {
  list: z.object({}).strict(),
  keep: z.object({ kind: z.enum(['distance', 'angle', 'radius', 'diameter', 'length']), a: pick, b: pick.optional() }).strict().refine((i) => (i.kind === 'distance' || i.kind === 'angle') === (i.b !== undefined), { message: 'distance and angle require two picks; other kinds require one' }),
  remove: z.object({ dimension: z.string().min(1) }).strict(),
  show: z.object({ showAll: z.boolean() }).strict(),
}

export interface AppDimensions {
  plate: string
  showAll: boolean
  dimensions: {
    id: string
    owner: { id: string; name: string }
    kind: 'distance' | 'angle' | 'radius' | 'diameter' | 'length'
    status: 'ok' | 'lost'
    value: number | null
    unit: 'mm' | 'deg'
    visible: boolean
    annotation: { from: number[]; to: number[]; label: string } | null
    a: { object: string; localPointMm: number[]; triangle: number }
    b?: { object: string; localPointMm: number[]; triangle: number }
    message?: string
  }[]
  kept?: string
  removed?: string
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', refused: 'not_supported', read_only: 'not_supported' }
export function appDimensionTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const commands = [
    ['list', 'app.dimensions', 'dimensions.list', 'Read every kept reference dimension on the shown plate, evaluated against the current geometry. Returns owner, status, measured value/unit, local anchors, world annotation and actual visibility. Lost anchors return status lost and no value; these annotations read geometry, never drive it.'],
    ['keep', 'app.dimension_keep', 'dimensions.keep', 'Keep a reference dimension on the model, as Keep this dimension in Measure does. Choose distance or angle with two surface picks, or radius, diameter or edge length with one. Picks use shown object IDs, zero-based part/triangle indices and a world point in mm. app_history lists object IDs; geom_faces with design set to that ID returns usable part, triangle and at fields. Mesh indices are transient: read/pick again after geometry changes. The engine measures the value; callers cannot supply a value. Returns the new ID and evaluated dimensions. One toolbar Undo removes the annotation.'],
    ['remove', 'app.dimension_remove', 'dimensions.remove', 'Remove one kept reference dimension by its ID from app_dimensions. Returns its ID and the remaining evaluated annotations. One toolbar Undo restores it.'],
    ['show', 'app.dimensions_show', 'dimensions.show', 'Set Show all kept dimensions, the Measure panel switch. With showAll false, selected objects still show their kept dimensions. Returns evaluated annotations and their actual visibility; this display preference adds no Undo step.'],
  ] as const
  return commands.map(([input, name, method, description]) => defineTool({
    name, version: '1.0.0', source: 'command', permission: input === 'keep' || input === 'remove' ? 'slice' : 'read',
    input: appDimensionInputs[input] as z.ZodType<Record<string, unknown>>,
    description: `${description} Needs ${appName}'s app link${input === 'keep' || input === 'remove' ? ' and an edit grant. Refuses locked objects and unfinished edits; validates before changing the project.' : ' and the existing read grant.'} Refuses stale results if the plate changes while measuring.`,
    ...(input === 'keep' || input === 'remove' ? { approval: async () => ({ title: input === 'keep' ? 'Keep this dimension?' : 'Remove this dimension?', lines: [], actions: [] }) } : {}),
    async run(i) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (--printers link).`, 'not_configured')
      try {
        const output = await link.call<AppDimensions>(method, i)
        return { summary: `${output.dimensions.length} kept dimensions read back.`, output }
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
        if (['app_link_off', 'app_closed', 'forbidden'].includes(code)) throw new ToolInputError('The app link is unavailable or this client is not allowed on it.', 'not_configured', { appLink: code })
        throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
      }
    },
  })) as PilotTool<never>[]
}
