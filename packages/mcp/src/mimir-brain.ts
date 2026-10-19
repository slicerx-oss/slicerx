// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir an edition is running, read over the app link (`mimir.brain`): its name, whether the edition gave it a
// voice, the tool groups it keeps on, mimir cloud's base model and the step-up the edition asks for, what it may
// remember, and how many docs of the edition's own knowledge it has. Metadata only: the voice text and the docs stay
// in the app, and only the fields below reach a client.
import { assistantText } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])

/** The app's answer to mimir.brain (packages/app app-link/mimir-brain.ts). */
export interface BrainState {
  name: string
  voice: boolean
  toolGroups: Record<string, boolean>
  cloud: { base: string; stepUp: string | null }
  memory: { local: boolean; sync: 'off' | 'opt-in' }
  knowledgeDocs: number
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The tool groups an edition can switch, the only keys toolGroups carries. */
const TOOL_GROUP_KEYS = ['design', 'slicing', 'printers', 'watch', 'paint', 'web'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Only the fields a client needs, so nothing else the app adds can leave it, and an answer of the wrong shape (an
 * older or broken app) reads as safe defaults rather than failing: always the six known tool groups, each on only
 * when the app said true.
 */
export function pick(raw: unknown): BrainState {
  const b = isRecord(raw) ? raw : {}
  const groups = isRecord(b['toolGroups']) ? b['toolGroups'] : {}
  const cloud = isRecord(b['cloud']) ? b['cloud'] : {}
  const memory = isRecord(b['memory']) ? b['memory'] : {}
  const docs = b['knowledgeDocs']
  return {
    name: typeof b['name'] === 'string' ? b['name'] : '',
    voice: b['voice'] === true,
    toolGroups: Object.fromEntries(TOOL_GROUP_KEYS.map((g) => [g, groups[g] === true])),
    cloud: { base: typeof cloud['base'] === 'string' ? cloud['base'] : '', stepUp: typeof cloud['stepUp'] === 'string' ? cloud['stepUp'] : null },
    memory: { local: memory['local'] === true, sync: memory['sync'] === 'opt-in' ? 'opt-in' : 'off' },
    knowledgeDocs: typeof docs === 'number' && Number.isInteger(docs) && docs > 0 ? docs : 0,
  }
}

export function mimirBrainTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const brain = defineTool({
    name: 'mimir.brain',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: assistantText(`Read the mimir the open ${appName} app runs as its edition sets it up, never the voice text or the docs themselves: the assistant's name, whether the edition gave it a voice, each tool group (design, slicing, printers, watch, paint, web) on or off, the model mimir cloud answers with and the step-up the edition asks for (null for none; the proxy decides), whether it remembers on this computer and whether memories sync, and how many docs of the edition's own knowledge it has.`),
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`reading mimir's setup needs the open ${appName} app: start the server with --printers link and turn on the app link`, 'not_configured')
      let out: unknown
      try {
        out = await link.call<unknown>('mimir.brain', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, 'internal_error')
      }
      const output = pick(out)
      const groups = Object.entries(output.toolGroups)
      const off = groups.filter(([, on]) => !on).map(([g]) => g)
      const summary = [
        `${output.name} in ${appName}: ${output.voice ? 'the edition voice' : 'the stock voice'}`,
        off.length ? `${groups.length - off.length} of ${groups.length} tool groups on (off: ${off.join(', ')})` : `all ${groups.length} tool groups on`,
        `mimir cloud on ${output.cloud.base || 'its base model'}${output.cloud.stepUp ? `, asks to step up to ${output.cloud.stepUp} (the proxy decides)` : ' with no step-up'}`,
        `memory ${output.memory.local ? 'on this computer' : 'off'}, sync ${output.memory.sync}`,
        `${plural(output.knowledgeDocs, 'doc')} of its own knowledge.`,
      ].join('; ')
      return { summary, output }
    },
  })
  return [brain] as PilotTool<never>[]
}
