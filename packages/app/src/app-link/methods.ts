// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an agent may do with the open project over the app link, and the page's answer to each. The hub keeps the same
// list (packages/connect/link/src/roles.rs, APP_LINK_METHODS) and refuses every other name before it reaches here; a
// test checks the two lists match. Nothing here prints, queues, approves, signs in or changes settings.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { appName, currentEdition } from '../edition'
import { mimirCloudHost, type MimirQuota } from '../pilot-connect/cloud'
import { bounds } from '../plate/transform'
import { LinkError } from './methods-error'
import { listSessions, readSession } from './sessions'
import { toolStore } from '../plate/tools'
import { get, pilotState, set, setCamera, showsLayers, type CameraView, type ColorMode } from '../state/store'

export type LinkClass = 'read' | 'edit'

export const APP_LINK_METHODS: Record<string, LinkClass> = {
  'app.info': 'read',
  'plate.list': 'read',
  // Moving, turning and scaling objects on the shown plate, each one undo step; the person sees who did it.
  'project.move': 'edit',
  'project.rotate': 'edit',
  'project.scale': 'edit',
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
  // the design timeline, and moving its marker (rolling the design back or forward)
  'design.timeline': 'read',
  'design.roll': 'edit',
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
  // A client's dimension sheet: asking puts a question in front of the person, so it is an edit.
  'sheet.ask': 'edit',
  'sheet.get': 'read',
  // mimir's conversations in this window: what was said and what mimir did.
  'mimir.sessions': 'read',
  'mimir.session': 'read',
  // today's mimir cloud use and caps; the install token stays in the shell
  'mimir.quota': 'read',
  // whether mimir cloud keeps this install's sessions (Settings > mimir), and whether the notice was read
  'mimir.share': 'read',
  // mimir cloud at a glance: offered, in use, signed in, and today's use when in use; no key or token
  'mimir.status': 'read',
}

export { LinkError } from './methods-error'

const round = (v: number): number => Math.round(v * 1000) / 1000

/** The client a call came from, as the hub knows it: its id and the name it gave. */
export interface LinkClient {
  id: string
  name: string
}

type Handler = (args: Record<string, unknown>, client: LinkClient) => unknown
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
  // Loaded when first used, so arranging stays out of the link's startup.
  'project.move': async (args, client) => (await import('./plate-edits')).move(args, client.name),
  'project.rotate': async (args, client) => (await import('./plate-edits')).rotate(args, client.name),
  'project.scale': async (args, client) => (await import('./plate-edits')).scale(args, client.name),
  'preview.get': () => previewState(),
  'preview.set': (args) => setPreview(args),
  // A client's dimension sheet for the person to confirm, and its answer read back by that client.
  'sheet.ask': async (args, client) => (await import('./sheets')).askSheet(args, client),
  'sheet.get': async (args, client) => (await import('./sheets')).getSheet(args, client),
  'mimir.sessions': () => listSessions(),
  'mimir.session': (args) => readSession(args),
  'mimir.quota': async () => {
    // loaded on use: only the desktop shell carries mimir cloud
    const { cloudReady } = await import('../pilot-connect/cloud-edition')
    const cloud = mimirCloudHost()
    if (!cloud || !cloudReady(currentEdition(), cloud)) throw new LinkError('not_found', `${appName()} has no ${ASSISTANT_NAME} cloud in this build`)
    return cloud.quota()
  },
  'design.timeline': async () => {
    const s = get()
    const { timelineSummary } = await import('@slicerx/cad-history')
    // shaped as the design tools reply, so the MCP server passes it on as it does theirs
    const output = { ...timelineSummary(s.timeline), rolledBack: s.rollback !== null }
    return { summary: `${output.items.length} ${output.items.length === 1 ? 'item' : 'items'}, ${output.rolledBack ? `rolled back to ${output.marker}` : 'at the end'}`, output }
  },
  'design.roll': async (args) => {
    const t = get().timeline
    const m = args['marker'] ?? t.items.length
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > t.items.length) throw new LinkError('invalid_input', `marker: a whole number from 0 to ${t.items.length} (the end)`)
    if (!linkLoader) throw new LinkError('not_ready', `${appName()} is still starting its design tools`)
    if (get().historyEdit) throw new LinkError('busy', 'the person is changing a step in the app; try again when they are done')
    const { rollTo } = await import('../cad/history/rollback')
    await rollTo(linkLoader, m)
    const s = get()
    const rolled = s.rollback !== null
    return { summary: rolled ? `Rolled back to ${s.timeline.marker} of ${s.timeline.items.length}` : 'At the end of the timeline', output: { marker: s.timeline.marker, end: s.timeline.items.length, rolledBack: rolled, objects: s.plate.length } }
  },
  'mimir.status': async () => {
    const [{ cloudOffered, cloudReady }, { pilotModel }] = await Promise.all([import('../pilot-connect/cloud-edition'), import('../pilot-connect/llm')])
    const s = get()
    const edition = currentEdition()
    const host = mimirCloudHost()
    const cloud = cloudOffered(edition, host)
    // waits for a sign-in (the browser build's cloud is for signed-in members); the desktop's needs none
    const needsSignIn = cloud && host?.needsSignIn === true
    const ready = cloudReady(edition, host)
    // On only, never the connect step: a fresh profile (mimir not chosen yet) would otherwise read the quota below
    const enabled = ready && pilotState(s) === 'on' && pilotModel(edition, s.pilot, ready)?.provider === 'mimir-cloud'
    const signedIn = linkSession ? await linkSession().catch(() => null) : null
    // Today's use only while mimir runs on the cloud: reading it registers an install that has none yet, which a status
    // read must not do for a person who turned mimir off, uses their own model or has not chosen yet.
    let quota: Omit<MimirQuota, 'v2'> | null = null
    let quotaError: { code: string; message: string } | null = null
    if (enabled && host) {
      try {
        const { v2: _v2, ...q } = await host.quota()
        quota = q
      } catch (e) {
        quotaError = { code: String((e as { code?: unknown }).code ?? 'service_error'), message: e instanceof Error ? e.message : String(e) }
      }
    }
    return { cloud, enabled, needsSignIn, signedIn, quota, quotaError }
  },
  'mimir.share': async () => {
    const [{ cloudReady }, { pilotModel }, { CLOUD_NOTICE_VERSION }] = await Promise.all([import('../pilot-connect/cloud-edition'), import('../pilot-connect/llm'), import('../pilot-connect/cloud-notice')])
    const s = get()
    const edition = currentEdition()
    const cloud = cloudReady(edition, mimirCloudHost())
    return {
      cloud,
      onCloud: cloud && pilotState(s) !== 'off' && pilotModel(edition, s.pilot, cloud)?.provider === 'mimir-cloud',
      share: s.mimirShare,
      noticeRead: s.mimirNotice === CLOUD_NOTICE_VERSION,
    }
  },
}

/** Whether the person is signed in to their account, read from the edition's store; unset in a build without one. */
let linkSession: (() => Promise<boolean>) | null = null

/** Gives the link a way to read whether the person is signed in (mimir.status), or takes it away. */
export function useLinkSession(read: (() => Promise<boolean>) | null): void {
  linkSession = read
}

/** The design tools, once the link has a loader to put bodies on the plate. */
let designTools: Map<string, PilotTool<never>> | null = null
let linkLoader: Loader | null = null

/** Gives the design tools the plate's design host. */
export async function useDesignHost(loader: Loader): Promise<void> {
  linkLoader = loader
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

/** Runs one call the hub handed over, from `client`. The hub already checked the method and the client's grant. */
export async function runCall(method: string, args: Record<string, unknown>, client: LinkClient = { id: '', name: 'An agent' }): Promise<unknown> {
  if (!Object.hasOwn(APP_LINK_METHODS, method)) throw new LinkError('not_found', `${appName()} has no app link method ${method}`)
  const h = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined
  if (h) return h(args, client)
  const tool = designTools?.get(method)
  if (!tool) throw new LinkError('not_ready', `${appName()} is still starting its design tools`)
  return runTool(tool, args)
}
