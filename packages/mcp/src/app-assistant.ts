// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const identity = z.object({
  name: z.string(),
  icon: z.string(),
  accent: z.union([z.string(), z.object({ light: z.string(), dark: z.string() })]).optional(),
  enabled: z.boolean(),
})

/** Reads the open app's edition, not this server's possibly different build configuration. */
export function appAssistantTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return [defineTool({
    name: 'app.assistant',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read the assistant identity of the edition open in ${appName}: its display name, icon image or builtin:mimir, optional accent (one color or light/dark colors), and whether the edition enables the assistant. Reads the app link; changes nothing. An absent accent follows the app theme.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`Open ${appName} with its app link enabled and use --printers link to read its assistant identity.`, 'not_configured')
      let info: { assistant?: unknown }
      try { info = await link.call('app.info', {}) }
      catch (error) {
        const code = String((error as { code?: unknown }).code ?? '')
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed to read it.`, 'not_configured')
        throw error
      }
      const parsed = identity.safeParse(info.assistant)
      if (!parsed.success) throw new ToolInputError(`The open ${appName} does not report its assistant identity; update the app.`, 'not_supported')
      return { summary: `${parsed.data.name}: assistant ${parsed.data.enabled ? 'enabled' : 'disabled'} in this edition.`, output: parsed.data }
    },
  })] as PilotTool<never>[]
}
