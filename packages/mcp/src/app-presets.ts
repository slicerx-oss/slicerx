// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's saved presets in the open app, through the app link, as Settings > Presets > Compare presets has them:
// listed, compared with another saved preset, the maker preset one was made from or the stock settings (the rows the
// panel lists, with keys), one setting's value copied into a preset, and that one setting put back. Each copy and undo
// changes a saved preset, which the link's grant does not cover, so the person approves it in the app every time, in a
// dialog that names the setting and the value. That dialog is the approval: these tools are slice class like the other
// app link edits and ask nothing here. A client allowed to read only is refused by the hub before any dialog. Nothing
// creates, renames, deletes or applies a preset.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', refused: 'not_supported', read_only: 'not_supported', denied: 'not_supported', bad_request: 'invalid_input' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

/** A copy or undo waits while the person answers in the app; the hub lets a call wait at most this long. */
export const PERSON_WAIT_MS = 120_000

async function call<T>(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await (opts ? link.call<T>(method, args, opts) : link.call<T>(method, args))
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? e)
    if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its saved presets cannot be reached.`, 'not_configured', { appLink: code })
    const details = (e as { details?: unknown }).details
    throw new ToolInputError(message, CODES[code] ?? 'internal_error', { appLink: code, ...(details && typeof details === 'object' ? (details as Record<string, unknown>) : {}) })
  }
}

const preset = z.string().trim().min(1).max(200).describe('A saved preset by id (from slicerx_app_presets) or by name')
const second = {
  with: z.string().trim().min(1).max(200).optional().describe('Another saved preset of the same kind, by id or name'),
  against: z.enum(['parent', 'stock']).optional().describe('Compare with the maker preset it was made from, or with the stock settings, instead of another preset'),
}
const oneSecond = (x: { with?: string | undefined; against?: string | undefined }): void => {
  if ((x.with === undefined) === (x.against === undefined)) throw new ToolInputError('Give the second side as with (another saved preset) or against ("parent" or "stock"), one of them.', 'invalid_input', { reason: x.with === undefined ? 'no_second' : 'two_seconds' })
}
const pick = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

interface Listed { id: string; kind: string; name: string; parent?: string; settings: number; inUse: boolean }

export function appPresetTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const list = defineTool({
    name: 'app.presets',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `List the presets the person saved in the open ${appName} app (Settings, Presets): id, kind (process, filament or printer), name, parent (the maker preset it was made from, when it names one), how many settings it changes, and inUse (the preset of its kind on the plate). Optional kind narrows the list. Reads through the app link.`,
    input: z.object({ kind: z.enum(['process', 'filament', 'printer']).optional().describe('Only presets of this kind') }),
    async run(i) {
      const out = await call<{ presets: Listed[] }>(link, appName, 'presets.list', pick({ kind: i.kind }))
      return { summary: `${out.presets.length} saved preset${out.presets.length === 1 ? '' : 's'} in ${appName}.`, output: out }
    },
  })
  const compare = defineTool({
    name: 'app.preset_compare',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Compare a preset the person saved in the open ${appName} app with another saved preset of its kind (with), or with the maker preset it was made from or the stock settings (against: "parent" or "stock"), exactly as Compare presets in the app lists them: each side read over the stock settings of the printer on the plate, the settings that differ (every setting of the kind with all: true, each marked differs), grouped by settings group, each with its label, key, both values and both as the app writes them, and the G-code line diff. Reads only.`,
    input: z.object({ preset, ...second, all: z.boolean().optional().describe('List every setting of the kind, not only those that differ') }),
    async run(i) {
      oneSecond(i)
      const out = await call<{ preset: Listed; with: { name: string }; differ: number }>(link, appName, 'presets.compare', pick({ preset: i.preset, with: i.with, against: i.against, all: i.all }))
      return { summary: `${out.preset.name} and ${out.with.name}: ${out.differ === 0 ? 'no settings differ' : `${out.differ} ${out.differ === 1 ? 'setting differs' : 'settings differ'}`}.`, output: out }
    },
  })
  const copy = defineTool({
    name: 'app.preset_copy',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Copy one setting's value into a preset the person saved in the open ${appName} app, from the second side of a compare (with another saved preset, or against "parent" or "stock"), as the copy button in Compare presets does. key is a setting key that slicerx_app_preset_compare lists as differing. A value equal to what the preset gets without it is dropped from the preset instead of being kept as a change; when the preset is in use, the plate follows. The person approves each copy in the app, in a dialog naming the setting and the value (the call waits for them, up to 2 minutes; this tool asks nothing itself); a decline is not_supported with details.reason "declined". Answers with value (what the preset gives now), kept (whether the preset holds it as its own change) and an undoId for slicerx_app_preset_undo. Needs the app link's edit grant.`,
    input: z.object({ preset, key: z.string().trim().min(1).max(100).describe('The setting key, from slicerx_app_preset_compare'), ...second }),
    async run(i) {
      oneSecond(i)
      const out = await call<{ preset: Listed; label: string; value: unknown; from: string; undoId: string }>(link, appName, 'presets.copy', pick({ preset: i.preset, key: i.key, with: i.with, against: i.against }), { timeoutMs: PERSON_WAIT_MS })
      return { summary: `${out.label} in ${out.preset.name} now has the ${out.from} value (undo with ${out.undoId}).`, output: out }
    },
  })
  const undo = defineTool({
    name: 'app.preset_undo',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Put back a copy slicerx_app_preset_copy made in the open ${appName} app, by its undoId: only the setting it copied goes back, and only while that setting still holds the copied value (otherwise not_supported, details.reason "changed"). An undoId already used or unknown, or a preset since deleted, is not_found. The person approves it in the app, as a copy. A client allowed to read only is refused (not_supported, details.appLink read_only) before the person is asked. Answers with the value read back. Needs the app link's edit grant.`,
    input: z.object({ undoId: z.string().trim().min(1).max(40).describe('The undoId from slicerx_app_preset_copy') }),
    async run(i) {
      const out = await call<{ preset: Listed; key: string; value: unknown }>(link, appName, 'presets.undo', { undoId: i.undoId }, { timeoutMs: PERSON_WAIT_MS })
      return { summary: `Put back ${out.key} in ${out.preset.name}.`, output: out }
    },
  })
  return [list, compare, copy, undo] as PilotTool<never>[]
}
