// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// User actions that touch the host: loading models, slicing, export, sending
// to a printer. Commands, buttons and Pilot tools all call these.
import type { ApprovalHost, ApprovalRequest, ApprovalToken, FileRef, Host, PermissionClass, PrinterInfo, SideEffectAction } from '@slicerx/contracts'
import { grantApproval, hashParams } from '@slicerx/contracts'
import type { QueueItem } from '../queue/queue'
import { clearProject } from '../project/new'
import { recognizedScript } from '../project/script-review'
import { get, markStale, set, toast, type AppState, selectedIds, type PendingApproval, type ModelSource } from './store'


let sliceAbort: AbortController | null = null
let seq = 0
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

// Opening models loads with the first open (open-models.ts), not with the app.
const models = () => import('./open-models')

/** Puts one of the built-in example models on the plate. */
export async function loadDemoModel(host: Host, slug: string, opts: { replace?: boolean; keep?: () => boolean } = {}): Promise<void> {
  return (await models()).loadDemoModel(host, slug, opts)
}

/** The example plate. */
export async function loadDefaultPlate(host: Host): Promise<void> {
  return (await models()).loadDefaultPlate(host)
}

/** The example a fresh session starts with, once, and never after a design was opened (open-models.ts). */
export async function seedExamplePlate(host: Host): Promise<void> {
  return (await models()).seedExamplePlate(host)
}

/** Open (the default) starts a new project with the files; `fresh: false` is Add model, onto the plate as it is. */
export async function openModelFiles(host: Host, opts: { fresh?: boolean } = {}): Promise<void> {
  // the picker opens before anything loads, while the click still counts as the person's
  const refs = await host.files.open({ accept: ['.stl', '.3mf', '.sx3mf', '.sxlock', '.obj', '.amf', '.step', '.stp', '.json', '.gcode'], multiple: true })
  await addFileRefs(host, refs, { fresh: opts.fresh ?? true })
}

/** Opens model bytes from somewhere other than a file dialog; `fresh` starts a new project. */
export async function openModelBytes(host: Host, name: string, data: ArrayBuffer, source?: ModelSource, opts: { fresh?: boolean } = {}): Promise<void> {
  return (await models()).openModelBytes(host, name, data, source, opts)
}

/** `fresh`: the files start a new project (Open); otherwise they go onto the plate as it is (Add model, a drop). */
export async function addFileRefs(host: Host, refs: FileRef[], opts: { fresh?: boolean } = {}): Promise<void> {
  return (await models()).addFileRefs(host, refs, opts)
}

export function removeSelected(): void {
  const ids = new Set(selectedIds())
  if (ids.size === 0) return
  const { plate } = get()
  set({ plate: plate.filter((p) => !ids.has(p.id)), selection: null, selectedIds: [] })
  markStale()
}

/**
 * Clears the plate for the next job: every plate, the project's printer and the settings it brought go with the
 * objects, as a new project does, so nothing of the old job reaches the next file.
 */
export function clearPlate(): void {
  clearProject()
}

/**
 * What the engine may trust and the limits of the target printer. The custom G-code is trusted only when it is the text
 * shipped for the selected model and the person has overridden none of the G-code settings (a user edit, an imported
 * preset or project), except with a project's G-code the person chose in the project G-code dialog and has not edited
 * since. Everything else gets the strict linter.
 */
export function trustOptions(s: Pick<AppState, 'profile' | 'overrides'> & Partial<Pick<AppState, 'vouchedGcode' | 'projectScriptReviews'>>): { trustedGcode?: true; machineLimits?: { nozzleMaxC?: number; bedMaxC?: number } } {
  const p = s.profile
  if (!p) return {}
  const vouched = s.vouchedGcode ?? {}
  const own = (k: string): boolean => k in s.overrides && !(k in vouched && JSON.stringify(s.overrides[k]) === JSON.stringify(vouched[k])) && !recognizedScript(k, s.overrides[k], p.printerId, s.overrides, s.projectScriptReviews?.records ?? [])
  const edited = p.gcodeKeys.some(own) || GCODE_TEXT_KEYS.some(own)
  return { ...(p.shippedGcode && !edited ? { trustedGcode: true as const } : {}), ...(Object.keys(p.limits).length ? { machineLimits: p.limits } : {}) }
}

export const GCODE_TEXT_KEYS = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode', 'filament_start_gcode', 'filament_end_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'time_lapse_gcode', 'toolchange_gcode', 'wrapping_detection_gcode', 'file_start_gcode', 'extruder_start_gcode', 'printing_by_object_gcode', 'change_extrusion_role_gcode', 'filament_change_extrusion_role_gcode', 'process_change_extrusion_role_gcode']

/** Starts a slice run: the one in flight is canceled, and the new run's controller becomes the current one. */
export function beginSlice(): AbortController {
  sliceAbort?.abort()
  sliceAbort = new AbortController()
  return sliceAbort
}

/** Whether this run is still the current slice (no newer one replaced it). */
export const currentSlice = (abort: AbortController): boolean => sliceAbort === abort

/** Ends a slice run, unless a newer one already replaced it. */
export function endSlice(abort: AbortController): void {
  if (sliceAbort === abort) sliceAbort = null
}

/** The slice run loads on first use, so the startup shell stays small (slice-plate.ts). */
export const loadSliceRun = () => import('./slice-plate')

/** `auto` is a background slice after an edit: nothing to say when there is nothing to slice, and a failure shows in the panel, not as a toast. */
export async function slicePlate(host: Host, opts: { auto?: boolean } = {}): Promise<void> {
  await (await loadSliceRun()).slicePlate(host, opts)
}

export function cancelSlice(opts: { quiet?: boolean } = {}): void {
  if (sliceAbort) {
    sliceAbort.abort()
    if (!opts.quiet) toast('Slice canceled')
  }
}

/** Whether a slice is in flight. */
export const slicing = (): boolean => sliceAbort !== null

/**
 * The job's name: the object's own on a plate of one, else the plate's, so a new print order does not rename it after
 * whichever object now prints first.
 */
export function jobName(s: Pick<AppState, 'plate' | 'plates' | 'activePlate'>): string {
  const printable = s.plate.filter((p) => p.printable !== false)
  if (printable.length === 1) return printable[0]!.name
  return s.plates.find((p) => p.id === s.activePlate)?.name ?? 'Plate 1'
}

/**
 * The file name for the slice: the engine's (Orca's `filename_format`, which starts with the first object's name), with
 * that start swapped for the job's name on a plate of more than one object.
 */
export function jobFileName(s: Pick<AppState, 'plate' | 'plates' | 'activePlate'>, engine: string | undefined): string {
  const job = jobName(s)
  if (!engine) return gcodeName(job)
  const first = s.plate.find((p) => p.printable !== false)?.name
  if (!first || job === first || !engine.startsWith(first)) return engine
  return job + engine.slice(first.length)
}

function gcodeName(plate: string): string {
  const slug = plate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plate'
  return `${slug}_plate-1.gcode`
}

/** What Export and Print say when the slice on screen is from before the plate changed. */
export const STALE_SLICE = 'The plate changed after this slice. Slice it again first.'

/**
 * One approval covering one or more host calls. Each action's hash is the
 * hash of the exact parameters the host will see (packages/contracts/src/pilot.ts).
 */
export async function buildApproval(opts: {
  tool: string
  permission: PermissionClass
  title: string
  lines: string[]
  printerId?: string
  actions: { action: SideEffectAction; target: string; params: unknown }[]
}): Promise<ApprovalRequest> {
  const actions = await Promise.all(opts.actions.map(async (a) => ({ action: a.action, target: a.target, paramsHash: await hashParams(a.params) })))
  return {
    id: uid('apr'),
    sessionId: 'ui',
    tool: opts.tool,
    permission: opts.permission,
    title: opts.title,
    lines: opts.lines,
    ...(opts.printerId ? { printerId: opts.printerId } : {}),
    paramsHash: await hashParams(opts.actions.map((a) => a.params)),
    actions,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}

/** Shows the approval dialog and resolves with a token only after the user presses Approve. */
export function askApproval(approvals: ApprovalHost, request: ApprovalRequest, extra: Pick<PendingApproval, 'checks' | 'confirm' | 'go'> = {}): Promise<ApprovalToken | null> {
  return new Promise((resolve, reject) => {
    set({
      approval: {
        requests: [request],
        ...extra,
        approve: async () => {
          set({ approval: null })
          try {
            await approvals.register(request)
            // The approve button of a card with `confirm` states it, so pressing it carries that answer.
            resolve(await grantApproval(approvals, request, Boolean(extra.confirm)))
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        },
        deny: async () => {
          set({ approval: null })
          try {
            await approvals.deny(request.id, 'Denied in the approval dialog')
          } finally {
            resolve(null)
          }
        },
      },
    })
  })
}

/**
 * The layer range a new slice shows. An ordinary slice starts at the full stack. A slice that replaces one after a
 * change made from Preview (norn) keeps the layer being looked at, clamped if the stack got shorter.
 */
export function layersAfterSlice(prev: { layerHi: number; layerLo: number; moveCut: number }, layerCount: number, keep: boolean): { layerHi: number; layerLo: number; moveCut: number } {
  if (!keep || prev.layerHi < 1) return { layerHi: layerCount, layerLo: 1, moveCut: 1 }
  const hi = Math.max(1, Math.min(prev.layerHi, layerCount))
  return { layerHi: hi, layerLo: Math.max(1, Math.min(prev.layerLo, hi)), moveCut: prev.moveCut }
}

/** The printer's own reason when an error is a refused start (`refused`), else null. */
export function refusalReason(e: unknown): string | null {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'refused') return null
  const m = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? '')
  const at = m.indexOf('refused the print: ')
  return (at >= 0 ? m.slice(at + 'refused the print: '.length) : m).trim() || 'The printer gave no reason.'
}

/**
 * The printer's reason when an error says a Bambu Lab printer takes no print from other apps until Developer Mode is
 * on (`needs_developer_mode`), else null.
 */
export function developerModeReason(e: unknown): string | null {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'needs_developer_mode') return null
  return afterPrefix(e, /(takes no prints from other apps|may need Developer Mode to take prints from this app): /)
}

/** The printer's reason when an error says its storage has no room for the file (`printer_storage_full`), else null. */
export function storageFullReason(e: unknown): string | null {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'printer_storage_full') return null
  return afterPrefix(e, /has no room for the file: /)
}

/** An error's message after the part that names the printer (`prefix`), or the whole message. */
function afterPrefix(e: object, prefix: RegExp): string {
  const m = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? '')
  const hit = prefix.exec(m)
  return (hit ? m.slice(hit.index + hit[0].length) : m).trim() || 'The printer gave no reason.'
}

/** The send and printer flow loads on first use, so the startup shell stays small (send-actions.ts). */
const sendActions = () => import('./send-actions')

export async function exportGcode(host: Host): Promise<void> {
  return (await sendActions()).exportGcode(host)
}

export async function sendToPrinter(host: Host, printer: PrinterInfo): Promise<void> {
  return (await sendActions()).sendToPrinter(host, printer)
}

export async function startQueued(host: Host, item: QueueItem): Promise<void> {
  return (await sendActions()).startQueued(host, item)
}

export async function recordSpoolUse(host: Host, uses: { spoolId: number; label: string; grams: number }[]): Promise<void> {
  return (await sendActions()).recordSpoolUse(host, uses)
}

export async function printerAction(host: Host, printer: PrinterInfo, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  return (await sendActions()).printerAction(host, printer, action)
}
