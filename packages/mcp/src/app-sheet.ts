// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A dimension sheet in front of the person, through the open app: a client lists the sizes it will build from, each
// with its source, and the person confirms them (or sets them aside) in the app before the client builds. The ask
// answers at once with the sheet's id; sheet_get reads the answer back. Offered while the app link is in use.
import { defineTool, sheetTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller, appName: string, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await link.call<Record<string, unknown>>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so the person cannot see the sheet`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

export function appSheetTools(link: AppLinkCaller, appName: string): PilotTool<never>[] {
  const ask = defineTool({
    name: 'app.sheet_ask',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Before building a part in the open ${appName} app, show the person every size it is built from (width, length, height, wall, holes, clearance and so on), each with its value, unit and source (asked, lookup with its page, photo, or guess), so they can confirm them. Answers at once with a sheet id; read the answer with slicerx_app_sheet_get and build only once it is confirmed, from the values it returns. One sheet waits per client at a time.`,
    input: sheetTool().input as z.ZodType<Record<string, unknown>>,
    async run(i) {
      const out = await call(link, appName, 'sheet.ask', i)
      return { summary: `Sheet ${String(out['sheetId'])} is waiting for the person in ${appName}.`, output: out }
    },
  })
  const get = defineTool({
    name: 'app.sheet_get',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Read back a sheet from slicerx_app_sheet_ask: waiting, confirmed (with the values to build with and the sizes the person changed), or declined (build nothing and ask what to change).',
    input: z.object({ sheet_id: z.string().min(1).max(80) }),
    async run(i) {
      const out = await call(link, appName, 'sheet.get', { sheetId: i.sheet_id })
      return { summary: `Sheet ${i.sheet_id} is ${String(out['state'])}.`, output: out }
    },
  })
  return [ask, get] as PilotTool<never>[]
}
