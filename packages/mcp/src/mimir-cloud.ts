// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud's share setting, read from the open app over the app link: whether the app runs mimir on mimir cloud,
// whether it keeps this install's sessions to improve mimir (Settings > mimir), and whether the person read the notice
// before the first chat. Changing it stays with the person in the app.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])

export function mimirCloudTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const share = defineTool({
    name: 'mimir.share',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read whether ${appName} runs mimir on mimir cloud, whether it shares this install's mimir sessions to improve mimir (Settings > mimir, on by default), and whether the person has read the notice shown before the first chat. Reads the open app over the app link; only the person changes the setting.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`reading the share setting needs the open ${appName} app: start the server with --printers link and turn on the app link`, 'not_configured')
      let out: { cloud: boolean; onCloud: boolean; share: boolean; noticeRead: boolean }
      try {
        out = await link.call('mimir.share')
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, 'internal_error')
      }
      const summary = !out.cloud
        ? `${appName} has no mimir cloud in this build, so nothing is shared.`
        : `Sharing mimir sessions is ${out.share ? 'on' : 'off'}${out.onCloud ? '' : ' (mimir runs on the person\'s own model now, which never shares)'}; the notice was ${out.noticeRead ? '' : 'not yet '}read.`
      return { summary, output: { cloud: out.cloud, on_cloud: out.onCloud, share: out.share, notice_read: out.noticeRead } }
    },
  })
  return [share] as PilotTool<never>[]
}
