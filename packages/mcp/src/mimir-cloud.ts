// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud read from the open app over the app link. The share setting: whether the app runs mimir on mimir cloud,
// whether it keeps this install's sessions to improve mimir (Settings > mimir), and whether the person read the notice
// before the first chat. Changing it stays with the person in the app. The status: whether the build offers mimir
// cloud, whether mimir runs on it, whether the person is signed in, and today's use while it runs there. Neither
// carries a key or a token: the install token stays in the app's keychain.
import { assistantText } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'
import { quotaOutput, quotaSummary, type Quota } from './mimir-quota'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])

export function mimirCloudTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const share = defineTool({
    name: 'mimir.share',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: assistantText(`Read whether ${appName} runs mimir on mimir cloud, whether it shares this install's mimir sessions to improve mimir (Settings > mimir, on by default), and whether the person has read the notice shown before the first chat. Reads the open app over the app link; only the person changes the setting.`),
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
        ? assistantText(`${appName} has no mimir cloud in this build, so nothing is shared.`)
        : assistantText(`Sharing mimir sessions is ${out.share ? 'on' : 'off'}${out.onCloud ? '' : ' (mimir runs on the person\'s own model now, which never shares)'}; the notice was ${out.noticeRead ? '' : 'not yet '}read.`)
      return { summary, output: { cloud: out.cloud, on_cloud: out.onCloud, share: out.share, notice_read: out.noticeRead } }
    },
  })
  const status = defineTool({
    name: 'mimir.cloud_status',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: assistantText(`Read mimir cloud's status in ${appName}: whether this build offers mimir cloud, whether mimir is on and runs on it, whether the person is signed in to their account (null in a build without accounts), whether mimir cloud waits for a sign-in, and today's use and what is left (only while mimir runs on mimir cloud). Reads the open app over the app link; carries no key or token. slicerx-mcp --mimir-cloud-status prints the same JSON from a shell.`),
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(assistantText(`reading mimir cloud's status needs the open ${appName} app: start the server with --printers link and turn on the app link`), 'not_configured')
      let out: CloudStatus
      try {
        out = await link.call<CloudStatus>('mimir.status', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, 'internal_error')
      }
      const output = {
        cloud: out.cloud,
        enabled: out.enabled,
        signed_in: out.signedIn,
        needs_sign_in: out.needsSignIn,
        quota: out.quota ? quotaOutput(out.quota) : null,
        quota_error: out.quotaError ? { code: out.quotaError.code, message: out.quotaError.message } : null,
      }
      const summary = !out.cloud
        ? assistantText(`${appName} has no mimir cloud in this build.`)
        : out.needsSignIn
          ? assistantText('mimir cloud waits for the person to sign in.')
          : !out.enabled
            ? assistantText('mimir cloud is available but mimir is off or runs on the person\'s own model.')
            : out.quota
              ? assistantText(`mimir runs on mimir cloud. ${quotaSummary(out.quota)}`)
              : assistantText(`mimir runs on mimir cloud; today's use could not be read (${out.quotaError?.code ?? 'unknown'}).`)
      return { summary, output }
    },
  })
  return [share, status] as PilotTool<never>[]
}

/** The app's answer to mimir.status (packages/app app-link/methods.ts). */
interface CloudStatus {
  cloud: boolean
  enabled: boolean
  needsSignIn: boolean
  signedIn: boolean | null
  quota: Quota | null
  quotaError: { code: string; message: string } | null
}
