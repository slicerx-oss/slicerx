// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two view preferences of the open app, through the app link: Frame the view (whether Model frames each pick, or only
// when it opens or an object is added) and Toolbar size (the Model ribbon's icons). They change how the window behaves,
// never the project, so both tools read. Each answer is the preferences read back. No other setting is reachable.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** The view preferences as the app reads them back (packages/app app-link/methods.ts, look.get). */
export interface AppLook {
  toolbarSize: 'large' | 'medium' | 'small'
  /** Absent in an edition without Model's modeling tools. */
  modelFraming?: 'selection' | 'open'
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_supported', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppLook> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppLook>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its view preferences cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const SIZE_WORDS: Record<AppLook['toolbarSize'], string> = { large: 'Large (32 px)', medium: 'Medium (24 px)', small: 'Small (16 px)' }
const FRAMING_WORDS: Record<NonNullable<AppLook['modelFraming']>, string> = { selection: 'Always', open: 'On open and add' }

function summary(l: AppLook): string {
  return `Toolbar size ${SIZE_WORDS[l.toolbarSize]}${l.modelFraming ? `; Frame the view: ${FRAMING_WORDS[l.modelFraming]}` : ''}.`
}

export function appLookTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const get = defineTool({
    name: 'app.look',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read two view preferences of ${appName} (Settings, Look and feel): toolbarSize (large, medium or small, the Model ribbon's icons at 32, 24 or 16 px) and modelFraming (selection: Model frames the view on every pick; open: only when Model opens or an object is added; absent in an edition without Model's modeling tools). Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'look.get', {})
      return { summary: summary(out), output: out }
    },
  })
  const setLook = defineTool({
    name: 'app.look_set',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Set ${appName}'s Frame the view (modelFraming: selection or open) or Toolbar size (toolbarSize: large, medium or small), or both, the way the person does in Settings, Look and feel. These change how the window behaves, never the project; no other setting can be changed here. Returns the preferences read back.`,
    input: z
      .object({
        modelFraming: z.enum(['selection', 'open']).optional().describe('selection: frame the view on every pick; open: only when Model opens or an object is added'),
        toolbarSize: z.enum(['large', 'medium', 'small']).optional().describe("The Model ribbon's icon size: 32, 24 or 16 px"),
      })
      .refine((i) => i.modelFraming !== undefined || i.toolbarSize !== undefined, { message: 'Give modelFraming, toolbarSize or both.' }),
    async run(i) {
      const out = await call(link, appName, 'look.set', { ...(i.modelFraming ? { modelFraming: i.modelFraming } : {}), ...(i.toolbarSize ? { toolbarSize: i.toolbarSize } : {}) })
      return { summary: summary(out), output: out }
    },
  })
  return [get, setLook] as PilotTool<never>[]
}
