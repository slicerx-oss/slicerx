// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an agent may do with the open project over the app link, and the page's answer to each. The hub keeps the same
// list (packages/connect/link/src/roles.rs, APP_LINK_METHODS) and refuses every other name before it reaches here; a
// test checks the two lists match. Nothing here prints, queues, approves, signs in or changes settings.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { appName, currentEdition } from '../edition'
import { cloudReady, mimirCloudHost } from '../pilot-connect/cloud'
import { bounds } from '../plate/transform'
import { LinkError } from './methods-error'
import { listSessions, readSession } from './sessions'
import { toolStore } from '../plate/tools'
import { get, set, setCamera, showsLayers, type CameraView, type ColorMode } from '../state/store'

export type LinkClass = 'read' | 'edit'

export const APP_LINK_METHODS: Record<string, LinkClass> = {
  'app.info': 'read',
  'plate.list': 'read',
  // The slice preview only changes what the window shows, never the project.
  'preview.get': 'read',
  'preview.set': 'read',
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
  // mimir's conversations in this window: what was said and what mimir did.
  'mimir.sessions': 'read',
  'mimir.session': 'read',
  // today's mimir cloud use and caps; the install token stays in the shell
  'mimir.quota': 'read',
}

export { LinkError } from './methods-error'

const round = (v: number): number => Math.round(v * 1000) / 1000

type Handler = (args: Record<string, unknown>) => unknown
type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

const CAMERAS: readonly CameraView[] = ['iso', 'top', 'front', 'fit']
const COLORS: readonly ColorMode[] = ['feature', 'tool', 'speed', 'flow', 'layerTime']

/** What the slice preview shows: the layers drawn, the colors and the camera. */
function previewState() {
  const s = get()
  const p = s.preview
  return {
    sliced: p !== null,
    toolpaths: showsLayers(s),
    camera: s.camera,
    ...(p
      ? {
          layers: p.layerCount,
          range: [s.layerLo, s.layerHi],
          oneLayer: s.layerLo === s.layerHi,
          topZMm: round(p.layerZ[s.layerHi - 1] ?? 0),
          colorMode: s.colorMode,
        }
      : {}),
  }
}

const layerArg = (v: unknown, n: number, key: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > n) throw new LinkError('invalid_input', `${key} is a layer from 1 to ${n}`)
  return v
}

/** Tools a person is in the middle of, which an agent's view change must not end. */
const BUSY_TOOLS = ['paint', 'brim', 'face']

/**
 * Moves the preview: `layer` (the top handle), `range` [bottom, top], `oneLayer`, `colorMode`, `camera`. It never
 * interrupts the person: it answers busy unless the window is already on Slice with no paint, brim or face tool open,
 * and it changes only what the window shows now, never a saved choice (the tab, the look, a picked color mode).
 */
function setPreview(args: Record<string, unknown>) {
  const s = get()
  if (s.workspace !== 'prepare' || s.modelMode !== 'slice' || BUSY_TOOLS.includes(toolStore.getState().tool)) {
    throw new LinkError('busy', 'the person is working elsewhere in the window; the preview moves only while Slice is open and no tool is in use')
  }
  if (args['camera'] !== undefined && !CAMERAS.includes(args['camera'] as CameraView)) throw new LinkError('invalid_input', `camera is one of ${CAMERAS.join(', ')}`)
  if (args['colorMode'] !== undefined && !COLORS.includes(args['colorMode'] as ColorMode)) throw new LinkError('invalid_input', `colorMode is one of ${COLORS.join(', ')}`)
  if (args['oneLayer'] !== undefined && typeof args['oneLayer'] !== 'boolean') throw new LinkError('invalid_input', 'oneLayer is true or false')
  const layered = ['layer', 'range', 'oneLayer', 'colorMode'].some((k) => args[k] !== undefined)
  let lo = s.layerLo
  let hi = s.layerHi
  if (layered) {
    const p = s.preview
    if (!p) throw new LinkError('not_ready', 'there is no slice to preview; slice the plate first')
    const n = p.layerCount
    if (args['range'] !== undefined) {
      const r = args['range']
      if (!Array.isArray(r) || r.length !== 2) throw new LinkError('invalid_input', 'range is [bottom, top]')
      lo = layerArg(r[0], n, 'range bottom')
      hi = layerArg(r[1], n, 'range top')
      if (lo > hi) throw new LinkError('invalid_input', 'the range bottom is above its top')
    }
    if (args['layer'] !== undefined) {
      hi = layerArg(args['layer'], n, 'layer')
      lo = Math.min(lo, hi)
    }
    if (args['oneLayer'] !== undefined) lo = args['oneLayer'] ? hi : 1
  }
  // Everything is checked before anything moves, so a refused call changes nothing.
  if (args['camera'] !== undefined) setCamera(args['camera'] as CameraView)
  if (layered) {
    // The color mode the person picked stays theirs: an agent's choice is not remembered as a pick.
    set({ layerLo: lo, layerHi: hi, moveCut: 1, toolChange: null, ...(args['colorMode'] !== undefined ? { colorMode: args['colorMode'] as ColorMode } : {}) })
  }
  return previewState()
}

/**
 * The bed the plate is laid out on, in the plate's coordinates (its front left corner at 0, 0): a round bed (a delta)
 * by its diameter and middle, any other by its width and depth. Objects' minMm and maxMm read against it.
 */
function bedShape() {
  const b = get().bed
  return b.round
    ? { shape: 'round', diameterMm: round(Math.min(b.widthMm, b.depthMm)), heightMm: round(b.heightMm), centerMm: [round(b.widthMm / 2), round(b.depthMm / 2)] }
    : { shape: 'rectangle', widthMm: round(b.widthMm), depthMm: round(b.depthMm), heightMm: round(b.heightMm) }
}

const HANDLERS: Record<string, Handler> = {
  'app.info': () => {
    const s = get()
    return { app: appName(), tab: s.modelMode, workspace: s.workspace, objects: s.plate.length, methods: APP_LINK_METHODS }
  },
  'plate.list': () => ({
    bed: bedShape(),
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
  'preview.get': () => previewState(),
  'preview.set': (args) => setPreview(args),
  'mimir.sessions': () => listSessions(),
  'mimir.session': (args) => readSession(args),
  'mimir.quota': () => {
    const cloud = mimirCloudHost()
    if (!cloud || !cloudReady(currentEdition(), cloud)) throw new LinkError('not_found', `${appName()} has no ${ASSISTANT_NAME} cloud in this build`)
    return cloud.quota()
  },
}

/** The design tools, once the link has a loader to put bodies on the plate. */
let designTools: Map<string, PilotTool<never>> | null = null

/** Gives the design tools the plate's design host. */
export async function useDesignHost(loader: Loader): Promise<void> {
  const [{ designToolset }, { appDesignHost }] = await Promise.all([import('@slicerx/mcp/toolset'), import('../cad/design-host')])
  designTools = new Map(designToolset(appDesignHost(loader)).filter((t) => Object.hasOwn(APP_LINK_METHODS, t.name)).map((t) => [t.name, t]))
}

const TOOL_CODES = new Set(['invalid_input', 'not_found'])

/** An agent's edit waits for the person: not while they edit a step of that object, or while it replays. */
async function personBusy(design: unknown): Promise<boolean> {
  if (typeof design !== 'string') return false
  const { replaying } = await import('../cad/history/ops')
  return get().historyEdit?.objectId === design || replaying(design)
}

async function runTool(tool: PilotTool<never>, args: Record<string, unknown>): Promise<unknown> {
  if (APP_LINK_METHODS[tool.name] === 'edit' && (await personBusy(args['design']))) {
    throw new LinkError('busy', 'the person is changing that object in the app; try again when they are done')
  }
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
