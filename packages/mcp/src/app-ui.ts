// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open app's window as the person sees it, through the app link: the workspace and the first tab's mode, the
// selection on the shown plate, the plate shown, the printer the project slices for and the panels open. Switching the
// workspace or tab changes only what the window shows, so that tool reads. Setting the selection and opening or closing
// panels is an edit, since the person's next click or key acts on them. Showing another plate is
// slicerx_app_plate_show's; the printer is read only, and the person picks it.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import type { ByObjectReadback } from '@slicerx/settings/by-object'
import { ToolInputError, type ErrorCode } from './errors'

/** The window as the app reads it back (packages/app app-link/ui.ts, ui.get). */
export interface AppUi {
  workspace: string
  workspaces: { id: string; label: string }[]
  tab: 'slice' | 'design' | 'mimir'
  tabs: ('slice' | 'design' | 'mimir')[]
  selection: { primary: { id: string; name: string | null } | null; objects: { id: string; name: string | null }[] }
  plate: { number: number; id: string; name: string; count: number }
  /** Null while no printer is chosen. Never an id, serial, access code or address. */
  printer: { name: string | null; vendor: string | null; model: string | null; nozzleMm: number | null; fromProject: boolean } | null
  panels: { open: string[]; settingsSection: string | null; settable: string[] }
  /** Printing by object, the shown plate's clearance plan (the app's warning and zones); null by layer. Older apps leave it out. */
  byObject?: (ByObjectReadback & { engine?: AppPlateCheck | null }) | null
  /** The shown slice's collisions, each naming its plate objects by id; null before a slice. Older apps leave it out. */
  collisions?: AppCollisions | null
}

/**
 * heimdall's plate check the window holds (packages/app app-link/ui.ts, plateCheckReadback): null where the app has
 * none (the web) or before it ran. Older apps leave it out.
 */
export interface AppPlateCheck {
  requestId: number
  status: 'running' | 'done' | 'error'
  /** Its answer is for the plate as it sits: the warning shows it in place of the footprint rule. */
  current: boolean
  micros: number | null
  collisions: { index: number; kind: string; severity: 'hit' | 'close'; part: string; certainty: 'sure' | 'slice_decides'; objects: { id: string; name: string | null }[] }[]
  fixes: unknown[]
  unchecked: { object: { id: string; name: string | null }; what: string; near: { id: string; name: string | null }[] }[]
}

/** The collisions of the slice the app shows (packages/app app-link/ui.ts, collisionsReadback). */
export interface AppCollisions {
  /** The plate changed since the slice. */
  stale: boolean
  items: {
    /** Its place in the list, for slicerx_app_collision_show. Older apps leave it out. */
    index?: number
    kind: string
    severity: 'hit' | 'close'
    part: string
    /** The plate objects it names, the one printing first. */
    objects: { id: string; name: string | null }[]
    /** The zone or the prime tower it meets, when that is no plate object. */
    zone?: string
    firstLayer: number
    lastLayer: number
    /** The plate object a hit strikes; null for a close call or when it names none. Older apps leave it out. */
    damaged?: { id: string; name: string | null } | null
    /** Where it goes deepest, and the region struck (null for a close call or an older engine), plate mm. */
    contactPoint?: [number, number, number]
    contactBox?: { min: [number, number, number]; max: [number, number, number] } | null
    /** Its row is the one picked. */
    picked?: boolean
  }[]
}

/** What collision.show answers (packages/app app-link/ui.ts, showCollision). */
export interface AppCollisionShown {
  picked: number
  selection: string[]
  cameraMoved: boolean
  collisions: AppCollisions | null
}

export const UI_PANELS = ['settings', 'command', 'about', 'shortcuts', 'expert', 'printerChooser', 'printerSettings'] as const

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call<T = AppUi>(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<T> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<T>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its window cannot be read.`, 'not_configured', { appLink: code })
    // busy: the person is using a tool, has work under way in a panel, or the window is busy; the same call can go again shortly.
    throw new ToolInputError(code === 'busy' ? `${message} (busy in ${appName}: wait a moment and call again)` : message, CODES[code] ?? 'internal_error')
  }
}

const TAB_WORDS: Record<AppUi['tab'], string> = { slice: 'Slice', design: 'Model', mimir: 'mimir' }

function summary(u: AppUi): string {
  const where = u.workspace === 'prepare' ? `${TAB_WORDS[u.tab] ?? u.tab} tab` : `${u.workspaces.find((w) => w.id === u.workspace)?.label ?? u.workspace} workspace`
  const picked = u.selection.objects.length ? `${u.selection.objects.length} selected (${u.selection.objects.map((o) => o.name ?? o.id).join(', ')})` : 'nothing selected'
  const plate = `plate ${u.plate.number} of ${u.plate.count}${u.plate.name ? ` (${u.plate.name})` : ''}`
  const printer = u.printer ? `printer ${u.printer.name ?? [u.printer.vendor, u.printer.model].filter(Boolean).join(' ')}` : 'no printer chosen'
  const panels = u.panels.open.length ? `open: ${u.panels.open.join(', ')}${u.panels.settingsSection ? ` (${u.panels.settingsSection})` : ''}` : 'no panel open'
  const close = u.byObject ? u.byObject.pairs.filter((p) => p.severity === 'block').length + u.byObject.tall.length : 0
  const calls = u.byObject ? u.byObject.pairs.filter((p) => p.severity === 'soft').length : 0
  const soft = calls ? `${calls} close ${calls === 1 ? 'call' : 'calls'} sx slices` : ''
  const byObject = u.byObject ? `; by object, ${close ? `${close} clearance ${close === 1 ? 'problem' : 'problems'}${soft ? ` and ${soft}` : ''} (slicerx_arrange spaces the objects)` : soft ? `${soft} (slicerx_arrange spaces the objects)` : 'clear'}${engineWords(u.byObject.engine)}` : ''
  return `${where}; ${picked}; ${plate}; ${printer}; ${panels}${byObject}${collided(u.collisions)}.`
}

/** The app's plate check in a few words, once it has answered for the plate as it sits. */
function engineWords(e: AppPlateCheck | null | undefined): string {
  if (!e?.current) return ''
  const sure = e.collisions.filter((c) => c.severity === 'hit' && c.certainty === 'sure').length
  const decides = e.collisions.filter((c) => c.severity === 'hit' && c.certainty === 'slice_decides').length
  if (!sure && !decides) return ', and the plate check finds nothing sx would refuse'
  return `; the plate check finds ${sure ? `${sure} sure ${sure === 1 ? 'strike' : 'strikes'}` : ''}${sure && decides ? ' and ' : ''}${decides ? `${decides} the slice decides` : ''}`
}

/** The slice's collisions in a few words: the first strike's objects, so a client knows what to select. */
function collided(c: AppCollisions | null | undefined): string {
  if (!c?.items.length) return ''
  const hits = c.items.filter((i) => i.severity === 'hit')
  const first = hits[0] ?? c.items[0]!
  const names = first.objects.map((o) => `${o.name ?? o.id} (${o.id})`).join(' and ')
  const count = hits.length ? `${hits.length} ${hits.length === 1 ? 'collision' : 'collisions'}` : `${c.items.length} close ${c.items.length === 1 ? 'call' : 'calls'}`
  return `; ${c.stale ? 'the last slice, before the plate changed, has' : 'the slice has'} ${count}${names ? `, the first ${names}` : ''}`
}

const defined = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined))

export function appUiTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const get = defineTool({
    name: 'app.ui',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description: `Read ${appName}'s window as the person sees it: workspace (with workspaces, the ids and labels the top bar offers), tab (the first workspace's mode: slice, design for Model, or mimir; tabs lists the ones shown), selection (primary and objects on the shown plate, primary first, each with id and name), plate (the plate shown: number from 1, id, name and count), printer (the one the project slices for: name, vendor, model, nozzleMm and fromProject for an opened project's own printer; null when none is chosen; never an id, serial, access code or address) and panels (open: the dialogs and panels up, such as settings, command, about, shortcuts, expert, printerChooser, printerSettings or setup; settingsSection, the Settings section shown; settable, the panels slicerx_app_ui_select opens). Reads through the app link; the app must be open with the link on. byObject, when the shown plate prints by object: needMm (the clearance), pairs closer than it (a and b with id and name, gapMm, severity: block when sx refuses the slice for it, soft when sx slices it as a close call), tall objects the gantry or lid would hit (id, name, topMm, what, limitMm), the gantry (rodMm, reachMm) and outlines (per object its footprint and its clearance zone, bed mm; zones that overlap are objects too close); null by layer. byObject.engine, on the desktop: heimdall's plate check the window holds (requestId, status running, done or error, current when it is for the plate as it sits and the warning shows it in place of the footprint rule, micros, collisions each with certainty sure or slice_decides and the objects it names, fixes, unchecked with the objects near); null where the app has none or before it ran. collisions, once the shown plate is sliced: each collision in the slice (kind, severity hit or close, part, objects it names with id and name, the one printing first, zone when it meets a keep-out zone or the prime tower, firstLayer and lastLayer counted from 1, index, damaged: the plate object a hit strikes, contactPoint and contactBox: where it goes deepest and the region struck in plate mm from the printable area's front left corner, picked while its row is) and stale when the plate changed since; slicerx_app_collision_show with the index picks one as a click on its row does, and slicerx_app_ui_select with the ids selects them; null before a slice.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'ui.get', {})
      return { summary: summary(out), output: out }
    },
  })
  const setUi = defineTool({
    name: 'app.ui_set',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Switch ${appName}'s window the way the person does: workspace (an id from slicerx_app_ui) or tab (slice, design or mimir, in the first workspace). It changes only what the window shows, never the project; set the selection and panels with slicerx_app_ui_select. It answers busy and changes nothing while the person has a tool open, a file is opening, the print sheet or a question about an opened project is up, a phone is being paired, or first-run setup is up. Returns the window read back.`,
    input: z
      .object({
        workspace: z.string().min(1).optional().describe('A workspace id from slicerx_app_ui workspaces'),
        tab: z.enum(['slice', 'design', 'mimir']).optional().describe('The first workspace mode: slice, design (Model) or mimir'),
      })
      .refine((i) => i.workspace !== undefined || i.tab !== undefined, { message: 'Give workspace, tab or both.' }),
    async run(i) {
      const out = await call(link, appName, 'ui.set', defined(i))
      return { summary: summary(out), output: out }
    },
  })
  const select = defineTool({
    name: 'app.ui_select',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Set what is selected in ${appName}'s window and which panel is open, the way the person does: selection (object ids or names on the shown plate, primary first; [] selects nothing), open (one panel: ${UI_PANELS.join(', ')}; expert, printerChooser and printerSettings open in Slice) with section for Settings (a section id such as look, controls or agents), and close (a panel, or all). The person's next click or key acts on them, so this needs an edit grant. It opens only the panel asked for and closes only the ones named; it answers busy and changes nothing when that would close or cover another dialog, or when a panel to close has the person's work under way (a command typed, a search typed, an unsaved field in Settings). It answers busy and changes nothing while the person has a tool open, a file is opening, the print sheet or a question about an opened project is up, a phone is being paired, or first-run setup is up. It never changes the project: to show another plate use slicerx_app_plate_show, and the printer is the person's to pick. Everything is checked before anything changes. Returns the window read back.`,
    input: z
      .object({
        selection: z.array(z.string().min(1)).max(500).optional().describe('Object ids or names on the shown plate, primary first; [] selects nothing'),
        open: z.enum(UI_PANELS).optional().describe('The panel to open'),
        section: z.string().min(1).optional().describe('With open: settings, the Settings section to show'),
        close: z.enum([...UI_PANELS, 'all']).optional().describe('A panel to close, or all'),
      })
      .refine((i) => Object.values(i).some((v) => v !== undefined), { message: 'Give selection, open or close.' })
      .refine((i) => i.section === undefined || i.open === 'settings', { message: 'section goes with open: settings.' }),
    async run(i) {
      const out = await call(link, appName, 'ui.select', defined(i))
      return { summary: summary(out), output: out }
    },
  })
  const show = defineTool({
    name: 'app.collision_show',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Pick a collision of the slice ${appName} shows, the way a click on its row in the Collisions list does: index (from slicerx_app_ui collisions, counted from 0). Its plate objects become the selection, ringed on the bed; the object a hit strikes is outlined in the hit color and the region struck is filled; the view frames them only when they are off screen. frame: true frames them either way; jump: true also moves the sliders to the moment and plays the head up to it, the camera turned to the strike. It shows the Slice tab when another one is up. The person's next click or key acts on the selection, so this needs an edit grant, and it answers busy and changes nothing as slicerx_app_ui_select does. It never changes the project or the slice. Returns picked, the selection, cameraMoved and the collisions read back.`,
    input: z.object({
      index: z.number().int().min(0).describe('The collision to pick, from slicerx_app_ui collisions'),
      frame: z.boolean().optional().describe('Frame its parts even when they are on screen'),
      jump: z.boolean().optional().describe('Also play the head to the moment and turn the camera to the strike, as Jump does'),
    }),
    async run(i) {
      const out = await call<AppCollisionShown>(link, appName, 'collision.show', defined(i))
      const item = out.collisions?.items.find((c) => c.index === out.picked) ?? out.collisions?.items[out.picked]
      const names = item?.objects.map((o) => `${o.name ?? o.id}${item.damaged?.id === o.id ? ' (hit)' : ''}`).join(' and ')
      return { summary: `Picked collision ${out.picked}${names ? `: ${names}` : ''}${out.cameraMoved ? ', the view framed it' : ''}.`, output: out }
    },
  })
  return [get, setUi, select, show] as PilotTool<never>[]
}
