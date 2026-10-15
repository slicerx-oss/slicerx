// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const viewport = z.object({
  pixelRatio: z.number().positive(),
  motionScale: z.number().positive(),
  motionFull: z.boolean(),
  degrade: z.object({ count: z.number().int().nonnegative(), lastAt: z.string().datetime().nullable() }),
  drawnPlate: z.number().int().positive().nullable(),
}).nullable()

export function appViewportTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return [defineTool({
    name: 'app.viewport',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read ${appName}'s live viewport pixelRatio, motionScale, motionFull, drawnPlate and degrade notices (count and lastAt, a UTC ISO 8601 time). Counts cover the current viewport's lifetime and include all degrade notices, not only GPU slowdowns. A new viewport resets them. viewport is null when no GPU view is mounted, including the 2D fallback. Reads through the app link; changes nothing.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`Open ${appName} with its app link enabled and use --printers link to read its viewport.`, 'not_configured')
      let info: { viewport?: unknown }
      try { info = await link.call('app.info', {}) }
      catch (error) {
        const code = String((error as { code?: unknown }).code ?? '')
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s app link is unavailable or this client is not allowed to read it.`, 'not_configured', { appLink: code })
        throw error
      }
      const parsed = viewport.safeParse(info.viewport)
      if (!parsed.success) throw new ToolInputError(`The open ${appName} does not report viewport telemetry; update the app.`, 'not_supported')
      const v = parsed.data
      return { summary: v ? `Viewport pixel ratio ${v.pixelRatio}, motion scale ${v.motionScale}; ${v.degrade.count} degrade notices.` : 'No GPU viewport is mounted.', output: { viewport: v } }
    },
  })] as PilotTool<never>[]
}
