// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingValue } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const object = z.string().min(1).describe('Concrete object id or unique name on the shown plate, from app_plate')
const key = z.string().min(1).max(120)
const value = z.union([z.number(), z.boolean(), z.string(), z.array(z.union([z.number(), z.boolean(), z.string()]))])

export const appObjectSettingsInputs = {
  get: z.object({ object, keys: z.array(key).min(1).max(512).optional().describe('Read effective values for these keys; omitted reads all settings that may vary per object') }).strict(),
  set: z.object({
    object,
    part: z.string().min(1).optional().describe('Part name from app_object_settings; omitted changes the object'),
    set: z.record(key, value).default({}),
    clear: z.array(key).max(512).default([]),
  }).strict(),
}

export interface AppObjectSettings {
  object: { id: string; name: string; source: string; settings: Record<string, SettingValue>; effective: Record<string, SettingValue> }
  parts: { name: string; settings: Record<string, SettingValue>; effective: Record<string, SettingValue> }[]
  plate: { id: string; settings: Record<string, SettingValue> }
  affected: { id: string; name: string; plate: string }[]
  warnings: string[]
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported' }

export function appObjectSettingsTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const call = async (method: string, args: Record<string, unknown>): Promise<AppObjectSettings> => {
    if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
    try {
      return await link.call<AppObjectSettings>(method, args)
    } catch (e) {
      const code = String((e as { code?: unknown }).code ?? '')
      if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed on it.`, 'not_configured', { appLink: code })
      throw new ToolInputError(e instanceof Error ? e.message : String(e), CODES[code] ?? 'internal_error')
    }
  }
  const read = defineTool({
    name: 'app.object_settings',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read an open ${appName} object's print overrides, each part's overrides, and effective values after plate, object and part inheritance. Lists linked copies sharing those overrides, including copies on other plates, and layer-height warnings. Only settings that can vary per object are included; printer connections and credentials are never returned. Needs the app link.`,
    input: appObjectSettingsInputs.get,
    async run(i) {
      const out = await call('object.settings', i)
      return { summary: `${out.object.name}: ${Object.keys(out.object.settings).length} object overrides, ${out.parts.length} parts.`, output: out }
    },
  })
  const edit = defineTool({
    name: 'app.object_settings_set',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Set or clear print overrides on an open ${appName} object or one named part, as in the Print settings card. Uses schema keys and units. Linked copies share changes, including copies on other plates. Validates every change before applying one toolbar Undo step, then reads back overrides and effective values. Plate-wide settings and custom G-code are refused. An empty patch reads back without adding Undo. Needs an edit grant on the app link.`,
    input: appObjectSettingsInputs.set,
    async approval(i) { return { title: `Change settings of ${i.object}${i.part ? ` / ${i.part}` : ''}?`, lines: [], actions: [] } },
    async run(i) {
      const out = await call('object.settings_set', i)
      return { summary: `${out.object.name}: settings read back for ${out.affected.length} linked object${out.affected.length === 1 ? '' : 's'}.`, output: out }
    },
  })
  return [read, edit] as PilotTool<never>[]
}
