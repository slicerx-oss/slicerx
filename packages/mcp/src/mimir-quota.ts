// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud's daily use for this computer, read from the app over the app link (`mimir.quota`). The install token
// stays in the app's keychain; this server never sees it and never calls the proxy itself. MCP clients bring their own
// model, so this is a read for the person's sake: how much free mimir is left today.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

/** The app's answer (packages/app pilot-connect/cloud.ts MimirQuota), in micro-dollars per Melbourne day. */
interface Quota {
  edition: string
  day: string
  installUsed: number
  installCap: number
  ipUsed: number
  ipCap: number
  editionOpen: boolean
}

const usd = (micros: number): number => Math.round(micros / 10_000) / 100
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

export function mimirQuotaTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const quota = defineTool({
    name: 'mimir.quota',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read today's free mimir use in ${appName} on this computer: what this install and this network have used of their daily caps, in US dollars, and whether mimir cloud is open today. Caps reset at midnight Melbourne time. Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
      let q: Quota
      try {
        q = await link.call<Quota>('mimir.quota', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed or its app link is off, so mimir's use cannot be read.`, 'not_configured')
        throw new ToolInputError(message, code === 'not_found' ? 'not_supported' : code === 'busy' ? 'busy' : 'service_error')
      }
      const left = Math.max(0, q.installCap - q.installUsed)
      return {
        summary: q.editionOpen ? `$${usd(left).toFixed(2)} of $${usd(q.installCap).toFixed(2)} free mimir use left today on this computer.` : 'mimir cloud is closed for today; it opens again after midnight Melbourne time.',
        output: {
          day: q.day,
          edition: q.edition,
          open: q.editionOpen,
          install: { used_usd: usd(q.installUsed), cap_usd: usd(q.installCap), left_usd: usd(left) },
          network: { used_usd: usd(q.ipUsed), cap_usd: usd(q.ipCap) },
          resets: 'midnight, Australia/Melbourne',
        },
      }
    },
  })
  return [quota] as PilotTool<never>[]
}
