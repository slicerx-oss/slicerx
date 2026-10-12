// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an agent may do with the open project over the app link, and the page's answer to each. The hub keeps the same
// list (packages/connect/link/src/roles.rs, APP_LINK_METHODS) and refuses every other name before it reaches here; a
// test checks the two lists match. Nothing here prints, queues, approves, signs in or changes settings.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { appName } from '../edition'
import { bounds } from '../plate/transform'
import { get } from '../state/store'

export type LinkClass = 'read' | 'edit'

export const APP_LINK_METHODS: Record<string, LinkClass> = {
  'app.info': 'read',
  'plate.list': 'read',
  // The design tools (@slicerx/mcp/toolset), run here on the plate's design host.
  'design.new': 'edit',
  'design.list': 'read',
  'design.steps': 'read',
  'design.edit_step': 'edit',
  'design.undo': 'edit',
  'design.redo': 'edit',
  'geom.faces': 'read',
  'geom.face_pick': 'read',
  'geom.edge_pick': 'read',
  'geom.sketch_check': 'read',
  'geom.extrude': 'edit',
  'geom.revolve': 'edit',
  'geom.push_pull': 'edit',
  'geom.boolean': 'edit',
  'geom.fillet': 'edit',
  'geom.chamfer': 'edit',
  'geom.info': 'read',
  'geom.measure': 'read',
}

/** A refusal with a code the hub passes on (invalid_input, not_found, not_ready, refused, busy). */
export class LinkError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'not_ready' | 'refused' | 'busy',
    message: string,
  ) {
    super(message)
  }
}

const round = (v: number): number => Math.round(v * 1000) / 1000

type Handler = (args: Record<string, unknown>) => unknown
type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

const HANDLERS: Record<string, Handler> = {
  'app.info': () => {
    const s = get()
    return { app: appName(), tab: s.modelMode, workspace: s.workspace, objects: s.plate.length, methods: APP_LINK_METHODS }
  },
  'plate.list': () => ({
    objects: get().plate.map((e) => {
      const b = bounds(e.parts, e.transform)
      return {
        id: e.id,
        name: e.name,
        parts: e.parts.length,
        transform: e.transform.map(round),
        ...(b ? { minMm: b.min.map(round), maxMm: b.max.map(round), sizeMm: b.max.map((v, i) => round(v - b.min[i]!)) } : {}),
        ...(e.history ? { steps: e.history.steps.length } : {}),
      }
    }),
  }),
}

/** The design tools, once the link has a loader to put bodies on the plate. */
let designTools: Map<string, PilotTool<never>> | null = null

/** Gives the design tools the plate's design host. */
export async function useDesignHost(loader: Loader): Promise<void> {
  const [{ designToolset }, { appDesignHost }] = await Promise.all([import('@slicerx/mcp/toolset'), import('../cad/design-host')])
  designTools = new Map(designToolset(appDesignHost(loader)).filter((t) => Object.hasOwn(APP_LINK_METHODS, t.name)).map((t) => [t.name, t]))
}

const TOOL_CODES = new Set(['invalid_input', 'not_found'])

async function runTool(tool: PilotTool<never>, args: Record<string, unknown>): Promise<unknown> {
  const parsed = tool.input.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  try {
    // The reply is the tool's own: a summary and sizes, never meshes.
    const out = await tool.run(parsed.data, {} as never)
    return { summary: out.summary, output: out.output ?? null }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    throw new LinkError(typeof code === 'string' && TOOL_CODES.has(code) ? (code as 'invalid_input' | 'not_found') : 'refused', e instanceof Error ? e.message : String(e))
  }
}

/** Runs one call the hub handed over. The hub already checked the method and the client's grant. */
export async function runCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  if (!Object.hasOwn(APP_LINK_METHODS, method)) throw new LinkError('not_found', `${appName()} has no app link method ${method}`)
  const h = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined
  if (h) return h(args)
  const tool = designTools?.get(method)
  if (!tool) throw new LinkError('not_ready', `${appName()} is still starting its design tools`)
  return runTool(tool, args)
}
