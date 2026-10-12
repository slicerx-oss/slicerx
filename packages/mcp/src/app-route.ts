// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools on the project open in the app: while the app link answers (the person turned it on and allowed
// this agent), each design tool runs in the app through `app.call`, so its steps land in the plate's history and undo.
// When the link is off or the app is closed, the tools run on this server's own designs as before. `--no-app` keeps
// them here always.
import type { PilotTool, ToolOutput } from '@slicerx/pilot'
import { ToolInputError, type ErrorCode } from './errors'

/** The design tools the app runs (the hub's pinned list); opening and saving files stay on this server. */
export const APP_DESIGN_TOOLS = new Set([
  'design.new',
  'design.list',
  'design.steps',
  'design.edit_step',
  'design.undo',
  'design.redo',
  'geom.faces',
  'geom.face_pick',
  'geom.edge_pick',
  'geom.sketch_check',
  'geom.extrude',
  'geom.revolve',
  'geom.push_pull',
  'geom.boolean',
  'geom.fillet',
  'geom.chamfer',
  'geom.info',
  'geom.measure',
])

/** The agent side of the app link (link-client `appLink.call`). */
export interface AppLinkCaller {
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>
}

/** Answers that mean the app is not there to take the call: run here instead. */
const NOT_THERE = new Set(['app_link_off', 'app_closed'])
/** Codes the app may answer with that the server's error codes have. */
const PASSED: Record<string, ErrorCode> = { invalid_input: 'invalid_input', not_found: 'not_found', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported' }

/** Whether a call works on a design (the app's), rather than a model file (this server's). */
function onDesign(name: string, input: Record<string, unknown>): boolean {
  if (name.startsWith('design.')) return true
  return typeof input['design'] === 'string' && input['model'] === undefined
}

/** The tools, with the design tools run in the app while the link answers. */
export function routeToApp(tools: PilotTool<never>[], link: AppLinkCaller, appName: string): PilotTool<never>[] {
  let told = false
  return tools.map((t) => {
    if (!APP_DESIGN_TOOLS.has(t.name)) return t
    const local = t.run.bind(t)
    const run = async (input: never, ctx: Parameters<typeof t.run>[1]): Promise<ToolOutput> => {
      const args = input as unknown as Record<string, unknown>
      if (!onDesign(t.name, args)) return local(input, ctx)
      let out: { summary?: string; output?: unknown }
      try {
        out = await link.call<{ summary?: string; output?: unknown }>(t.name, args)
      } catch (e) {
        const code = (e as { code?: unknown }).code
        if (typeof code === 'string' && NOT_THERE.has(code)) return local(input, ctx)
        throw new ToolInputError(e instanceof Error ? e.message : String(e), (typeof code === 'string' && PASSED[code]) || 'internal_error')
      }
      // The first reply says where designs live now, once per session.
      const note = told ? '' : ` Designs now live in the project open in ${appName}, with their steps in its history; start the server with --no-app to keep them here.`
      told = true
      return { summary: `${out.summary ?? t.name} (in ${appName})${note}`, output: { ...(typeof out.output === 'object' && out.output ? out.output : { result: out.output ?? null }), in: 'app' } }
    }
    return { ...t, run }
  })
}
