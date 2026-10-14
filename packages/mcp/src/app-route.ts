// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools on the project open in the app: while the app link answers (the person turned it on and allowed
// this agent), each design tool runs in the app through `app.call`, so its steps land in the plate's history and undo.
// When the link is off or the app is closed, the tools run on this server's own designs as before. `--no-app` keeps
// them here always; `--app` keeps them in the app always, and refuses rather than fall back.
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
  'design.timeline',
  'design.roll',
  'design.sketch',
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
  'geom.hole',
  'geom.shell',
  'geom.info',
  'geom.measure',
])

/** Moving, turning and scaling objects, which run on the app's shown plate when the object is not this server's. */
export const APP_PROJECT_TOOLS = new Set(['project.move', 'project.rotate', 'project.scale'])

/** The agent side of the app link (link-client `appLink.call`). */
export interface AppLinkCaller {
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>
}

/**
 * Answers that mean the app link is not this server's to use: the link is off, the app is closed, the hub does not
 * take this client on the link (a partner key, or one paired by code alone), or the hub is older than the link and
 * does not know `app.call`. The call runs on the server's own designs instead. Any other refusal, such as arguments
 * over the link's size, comes back as it is.
 */
function notThere(code: string, message: string): boolean {
  return ['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code) || (code === 'bad_request' && message.startsWith('unknown method'))
}
/** Why the link is not there, for `--app`, which refuses instead of falling back. */
function whyNotThere(code: string, appName: string): string {
  if (code === 'app_link_off') return `the app link is off: turn it on in ${appName}'s Settings, or run without --app`
  if (code === 'app_closed') return `${appName} is not open: open it, or run without --app`
  if (code === 'bad_request') return `this sx-link is older than the app link: update ${appName}, or run without --app`
  return `this client is not allowed on the app link: allow it when ${appName} asks, or run without --app`
}
/** Codes the app may answer with that the server's error codes have. */
const PASSED: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported', busy: 'busy', pending: 'busy', not_answered: 'busy' }

/** Whether a call works on a design (the app's), rather than a model file (this server's). */
function onDesign(name: string, input: Record<string, unknown>): boolean {
  if (name.startsWith('design.')) return true
  return typeof input['design'] === 'string' && input['model'] === undefined
}

export interface RouteOptions {
  /** `--app`: these calls never run here; while the link does not answer they are refused with not_configured. */
  required?: boolean
  /** Whether this server's open project has the object (by id or name); such a call stays here. */
  serverHas?: (object: string) => boolean
}

/** Whether a call goes to the app: a design, or an object this server's own project does not have. */
function onApp(name: string, input: Record<string, unknown>, opts: RouteOptions): boolean {
  if (!APP_PROJECT_TOOLS.has(name)) return onDesign(name, input)
  return Boolean(opts.required) || !opts.serverHas?.(String(input['object'] ?? ''))
}

/**
 * The tools, with the design tools and the plate edits (project.move, .rotate and .scale on an object this server's
 * project does not have) run in the app while the link answers.
 */
export function routeToApp(tools: PilotTool<never>[], link: AppLinkCaller, appName: string, opts: RouteOptions = {}): PilotTool<never>[] {
  let told = false
  return tools.map((t) => {
    if (!APP_DESIGN_TOOLS.has(t.name) && !APP_PROJECT_TOOLS.has(t.name)) return t
    const local = t.run.bind(t)
    const run = async (input: never, ctx: Parameters<typeof t.run>[1]): Promise<ToolOutput> => {
      const args = input as unknown as Record<string, unknown>
      if (!onApp(t.name, args, opts)) return local(input, ctx)
      let out: { summary?: string; output?: unknown }
      try {
        out = await link.call<{ summary?: string; output?: unknown }>(t.name, args)
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (notThere(code, message)) {
          if (opts.required) throw new ToolInputError(whyNotThere(code, appName), 'not_configured', { appLink: code })
          return local(input, ctx)
        }
        const mapped = PASSED[code] ?? 'internal_error'
        // busy: the person is working in the app, or a question is up; the same call can go again shortly.
        throw new ToolInputError(mapped === 'busy' ? `${message} (busy in ${appName}: wait a moment and call again)` : message, mapped)
      }
      // The first reply says where designs live now, once per session.
      const note = told || opts.required || APP_PROJECT_TOOLS.has(t.name) ? '' : ` Designs now live in the project open in ${appName}, with their steps in its history; start the server with --no-app to keep them here.`
      told = true
      return { summary: `${out.summary ?? t.name} (in ${appName})${note}`, output: { ...(typeof out.output === 'object' && out.output ? out.output : { result: out.output ?? null }), in: 'app' } }
    }
    return { ...t, run }
  })
}
