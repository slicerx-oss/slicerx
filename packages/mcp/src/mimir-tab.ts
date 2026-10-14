// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What answers in the mimir tab of the open app, read over the app link: a model (which one, and the pair Auto moves
// between) or the scripted replies the tab plays until a model is set up, and the tools mimir has there. Carries no
// key or token. Changing the model stays with the person, in Settings > mimir.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])

/** The app's answer to mimir.tab (packages/app workspaces/mimir/session.ts). */
interface TabState {
  link: 'none' | 'scripted' | 'model'
  provider: string | null
  model: string | null
  auto: { huginn: string; muninn: string } | null
  tools: string[]
}

export function mimirTabTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const tab = defineTool({
    name: 'mimir.tab',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read what answers in the mimir tab of the open ${appName} app: "model" when a model is set up (its provider and model, and with Auto the small model it starts on and the larger one it moves to for a picture, a PDF or a part of many steps), "scripted" when no model is set up and the tab plays scripted replies, or "none" before the tab first opens. Also lists the tools mimir has in the tab (the design tools, so each step lands in the timeline). Carries no key or token.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`reading the mimir tab needs the open ${appName} app: start the server with --printers link and turn on the app link`, 'not_configured')
      let out: TabState
      try {
        out = await link.call<TabState>('mimir.tab', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, 'internal_error')
      }
      // only the fields a client needs; anything else the app adds stays out
      const output = { link: out.link, provider: out.provider, model: out.model, auto: out.auto ? { huginn: out.auto.huginn, muninn: out.auto.muninn } : null, tools: [...out.tools] }
      const summary =
        out.link === 'none'
          ? `The mimir tab has not been opened in ${appName} yet.`
          : out.link === 'scripted'
            ? 'The mimir tab plays scripted replies: no model is set up in Settings > mimir.'
            : out.auto
              ? `The mimir tab runs ${out.provider} on Auto: ${out.auto.huginn}, and ${out.auto.muninn} for a picture, a PDF or a part of many steps.`
              : `The mimir tab runs ${out.provider} with ${out.model}.`
      return { summary, output }
    },
  })
  return [tab] as PilotTool<never>[]
}
