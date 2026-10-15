// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingValue } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const object = z.string().min(1).describe('Object id or unique name on the shown plate')
const volume = z.string().min(1).describe('Volume id from app_volumes')
const role = z.enum(['negative', 'support_blocker', 'support_enforcer', 'modifier'])
const vec3 = z.tuple([z.number(), z.number(), z.number()])
const size = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])
const key = z.string().min(1).max(120)
const value = z.union([z.number(), z.boolean(), z.string(), z.array(z.union([z.number(), z.boolean(), z.string()]))])
const settings = z.record(key, value)

/** Shared input contracts for the command line, MCP and the open app. */
export const appVolumeInputs = {
  list: z.object({ object }).strict(),
  add: z.object({
    object, role, shape: z.enum(['box', 'cylinder', 'sphere', 'cone']),
    positionMm: vec3.optional().describe("Center in the object's coordinates; defaults to the object's center"),
    sizeMm: size.optional().describe('Dimensions along the volume axes in mm; omitted uses the app default'),
    settings: settings.default({}).describe('Print overrides for a modifier only'),
  }).strict(),
  fromObject: z.object({ object, source: object.describe('Another shown object to turn into this volume, keeping its world position'), role }).strict(),
  set: z.object({
    object, volume, role: role.optional(),
    positionMm: vec3.optional().describe("Absolute center in the object's coordinates, in mm"),
    rotationDeg: vec3.optional().describe('Absolute rotation about X, Y and Z in degrees'),
    sizeMm: size.optional().describe('Absolute dimensions along the volume axes in mm'),
    set: settings.default({}), clear: z.array(key).max(512).default([]),
  }).strict(),
  copy: z.object({ object, volume, target: object.optional().describe('Destination object; omitted duplicates in the same object') }).strict(),
  remove: z.object({ object, volume }).strict(),
}

export interface AppVolumes {
  object: { id: string; name: string }
  plate: string
  volumes: {
    id: string
    name: string
    role: 'negative' | 'support_blocker' | 'support_enforcer' | 'modifier'
    positionMm: number[]
    rotationDeg: number[]
    sizeMm: number[]
    local: number[]
    world: number[]
    boundsMm: { min: number[]; max: number[] } | null
    triangles: number
    settings: Record<string, SettingValue>
  }[]
  changed?: string[]
  removed?: string[]
  consumedObject?: string
}

const CODES: Record<string, ErrorCode> = {
  invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found',
  busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported',
}

export function appVolumeTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const call = async (method: string, args: Record<string, unknown>): Promise<AppVolumes> => {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
    try {
      return await link.call<AppVolumes>(method, args)
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed on it.`, 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  const commands = [
    ['list', 'app.volumes', 'volumes.list', 'Read an open object\'s negative volumes, support blockers, support enforcers and modifiers. Returns ids, roles, local and world placement, world bounds, sizes and print overrides.'],
    ['add', 'app.volume_add', 'volumes.add', 'Add a box, cylinder, sphere or cone volume to an open object, as in Prepare. Choose its role, optional center and dimensions; modifiers may carry print settings. Returns the new id and the resulting volume list.'],
    ['fromObject', 'app.volume_from_object', 'volumes.from_object', 'Turn another shown object into a volume of this object, keeping its world placement. Consumes the source object. One toolbar Undo restores both objects. Returns the new volume and consumed source id.'],
    ['set', 'app.volume_set', 'volumes.set', 'Change a volume\'s role, position, rotation, size or modifier settings. Values are absolute in object coordinates. Clear removes named print overrides. A role other than modifier drops its print overrides. Validates the whole patch before one toolbar Undo; an unchanged patch adds none. Returns the resulting volumes.'],
    ['copy', 'app.volume_copy', 'volumes.copy', 'Copy a volume into this or another shown object without changing the clipboard. In the same object it keeps its place; in another it lands beside that object, as Paste does. Retains role and modifier settings, returns the new id and resulting volumes, and uses one toolbar Undo.'],
    ['remove', 'app.volume_remove', 'volumes.remove', 'Remove one volume by id from an open object. Returns the removed id and the remaining volumes. One toolbar Undo restores it.'],
  ] as const
  return commands.map(([input, name, method, description]) => defineTool({
    name, version: '1.0.0', source: 'command', permission: input === 'list' ? 'read' : 'slice',
    description: `${description} Needs the app link${input === 'list' ? '.' : ' and an edit grant.'}`,
    input: appVolumeInputs[input] as z.ZodType<Record<string, unknown>>,
    ...(input === 'list' ? {} : { approval: async (i: Record<string, unknown>) => ({ title: `Change volumes of ${i['object']}?`, lines: [], actions: [] }) }),
    async run(i) {
      const out = await call(method, i)
      return { summary: `${out.object.name}: ${out.volumes.length} volumes read back.`, output: out }
    },
  })) as PilotTool<never>[]
}
