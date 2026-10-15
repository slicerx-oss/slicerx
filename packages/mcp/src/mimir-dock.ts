// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What answers in the docked mimir chat of the open app, read over the app link: a model (which one, and whether it
// runs on this computer) or the built-in demo, and the tools the model is offered there. A local model gets only the
// dock's own tools, so the list is what the model really sees. Carries no key or token; changing the model stays with
// the person, in Settings > mimir.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])

/** The app's answer to mimir.dock (packages/app features/pilot/dock-model.ts). */
interface DockState {
  link: 'none' | 'demo' | 'model'
  provider: string | null
  model: string | null
  local: boolean
  tools: string[]
}

export function mimirDockTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const dock = defineTool({
    name: 'mimir.dock',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read what answers in the docked mimir chat of the open ${appName} app: "model" when a model is set up (its provider and model, and whether it runs locally on this computer), "demo" when no model answers and the built-in demo does, or "none" before the chat is set up. Also lists the tools the model is offered there; a local model gets a shorter list that fits its context. Carries no key or token.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`reading the docked chat needs the open ${appName} app: start the server with --printers link and turn on the app link`, 'not_configured')
      let out: DockState
      try {
        out = await link.call<DockState>('mimir.dock', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, 'internal_error')
      }
      // only the fields a client needs; anything else the app adds stays out
      const output = { link: out.link, provider: out.provider, model: out.model, local: out.local === true, tools: [...out.tools] }
      const summary =
        out.link === 'none'
          ? `The docked mimir chat is not set up in ${appName} yet.`
          : out.link === 'demo'
            ? `The docked mimir chat plays the built-in demo: no model answers. It offers ${out.tools.length} tools.`
            : `The docked mimir chat runs ${out.provider} with ${out.model}${output.local ? ' on this computer' : ''}, offering ${out.tools.length} tools.`
      return { summary, output }
    },
  })
  return [dock] as PilotTool<never>[]
}
