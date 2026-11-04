// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print watch's per-printer settings as the hub holds them, read only: auto-pause, huginn's second look, the bed
// mask and the camera guard (on or off, its current trip, its empty-plate picture time), beside whether the watch takes
// frames from the printer now. Turning any of them on, answering a trip and the trip's frame are the person's, in the
// app; the hub refuses those calls from an agent connection.
import { productName } from '@slicerx/contracts'
import type { GuardState, GuardTrip } from '@slicerx/link-client'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

/** What an agent connection may read of the print watch (link-client `settings.get`, `watch.huginnPrinters`, `watch.masks`, `watch.guardState`). */
interface WatchReads {
  settings: { get(): Promise<{ watchAutoPausePrinters?: string[] }> }
  watch: { huginnPrinters(): Promise<string[]>; masks(): Promise<Record<string, unknown>>; guardState?(): Promise<GuardState> }
}

function watchReadsOf(host: unknown): WatchReads | undefined {
  const h = host as Partial<WatchReads> | undefined
  return typeof h?.settings?.get === 'function' && typeof h.watch?.huginnPrinters === 'function' && typeof h.watch.masks === 'function' ? (h as WatchReads) : undefined
}

/** One printer's print watch row. */
export interface PrintWatchRow {
  printerId: string
  name: string
  state: string | null
  /** `can_watch` when the printer has a camera, `no_camera` when not, null when its status did not answer. */
  camera: 'can_watch' | 'no_camera' | null
  /** The hub hands this printer's frames to the detector now: it prints and has a camera. */
  watchedNow: boolean
  autoPause: boolean
  huginn: boolean | null
  /** Auto-pause on and huginn on: the only case in which the watch may pause this printer on a failure. */
  pausesOnFailure: boolean
  bedMask: boolean | null
  /** The camera guard watches this printer (the person did not turn it off), null when the hub does not answer `watch.guardState`. */
  guard: boolean | null
  /** The guard's current trip on this printer (a hand, or a plate check), null when there is none or the hub does not answer. */
  guardTrip: Omit<GuardTrip, 'printerId'> | null
  /** When this printer's empty-plate picture was taken (ISO 8601), null when there is none or the hub does not answer. */
  guardPlate: string | null
}

/** The trip as the hub reports it, without the printer id (the row has it) and the hub's own bookkeeping. */
function tripOf(t: GuardTrip | undefined): Omit<GuardTrip, 'printerId'> | null {
  if (!t || typeof t !== 'object') return null
  const { kind, state, at, box, note, confidence, monitorOnly, startedBy, plateFrom, capturedAt, answered, answeredBy } = t
  const out = { kind, state, at, box, note, confidence, monitorOnly, startedBy, plateFrom, capturedAt, answered, answeredBy }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Omit<GuardTrip, 'printerId'>
}

const NO_WATCH = { reason: 'no_watch' } as const

/** Read in parallel; a hub too old for one read leaves that column null instead of failing the whole call. */
const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'print_watch.status',
    title: 'Print watch status',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description:
      `Read the print watch's settings for each printer (or one, with printerId) as the ${productName()} hub holds them: autoPause, the person's standing permission for the watch to pause that printer on a failure; huginn, whether huginn's second look (one camera frame to the connected assistant account) confirms a finding first; pausesOnFailure, true only when both are on, since the watch pauses only a confirmed finding of 0.8 or more; bedMask, whether the person drew a bed mask; watchedNow, whether the hub hands the printer's frames to the detector now (it prints and has a camera); guard, whether the camera guard watches the printer; guardTrip, its current trip (kind hand or plate, state paused, alert, blocked or clear, at, and when the guard could tell box, note, confidence, answered); and guardPlate, when its empty-plate picture was taken. detector says whether a failure detector is connected to the hub. huginn and bedMask are null when the hub does not answer those reads, and guard, guardTrip, guardPlate and detector when it does not answer the guard's. The trip's frame and findings are shown in the app only. Changing any of these, or answering a trip, is done by the person in the app; no tool can. Simulated printers have no print watch and are refused with not_supported and reason no_watch.`,
    input: z.object({ printerId: z.string().min(1).optional().describe('Id from slicerx_printer_list, such as "bay-1". Leave out for every printer.') }),
    hints: { idempotent: false, openWorld: true },
    async run(args) {
      const reads = printers.kind === 'link' ? watchReadsOf(printers.host) : undefined
      if (!reads) throw new ToolInputError(`These printers have no print watch. It runs beside the ${productName()} app, through its hub.`, 'not_supported', NO_WATCH)
      const [list, settings, huginn, masks, guard] = await Promise.all([
        printers.host.list(),
        reads.settings.get(),
        orNull(reads.watch.huginnPrinters.call(reads.watch)),
        orNull(reads.watch.masks.call(reads.watch)),
        typeof reads.watch.guardState === 'function' ? orNull(reads.watch.guardState.call(reads.watch)) : Promise.resolve(null),
      ])
      const chosen = args.printerId ? list.filter((p) => p.id === args.printerId) : list
      if (args.printerId && chosen.length === 0) throw new ToolInputError(`No printer ${args.printerId}.`, 'not_found')
      const autoPause = new Set(settings.watchAutoPausePrinters ?? [])
      const second = huginn ? new Set(huginn) : null
      const guardOff = guard ? new Set(Array.isArray(guard.off) ? guard.off : []) : null
      const rows: PrintWatchRow[] = await Promise.all(
        chosen.map(async (p) => {
          const status = await orNull(printers.host.status(p.id))
          const camera = status ? (status.cameraAvailable ? 'can_watch' : 'no_camera') : null
          const on = autoPause.has(p.id)
          const confirms = second ? second.has(p.id) : null
          const plate = guard?.plates?.[p.id]
          return {
            printerId: p.id,
            name: p.name,
            state: status?.state ?? null,
            camera,
            watchedNow: status?.state === 'printing' && camera === 'can_watch',
            autoPause: on,
            huginn: confirms,
            pausesOnFailure: on && confirms === true,
            bedMask: masks ? Array.isArray(masks[p.id]) : null,
            guard: guardOff ? !guardOff.has(p.id) : null,
            guardTrip: tripOf(guard?.trips?.[p.id]),
            guardPlate: typeof plate === 'string' ? plate : null,
          } satisfies PrintWatchRow
        }),
      )
      d.gate.log.append({ tool: 'print_watch.status', permission: 'read', decision: 'read', input_hash: args.printerId ?? '*', ok: true })
      const on = rows.filter((r) => r.autoPause).map((r) => r.name)
      const summary = args.printerId
        ? `${rows[0]?.name ?? args.printerId}: auto-pause ${rows[0]?.autoPause ? 'on' : 'off'}${rows[0]?.watchedNow ? ', watched now' : ''}`
        : `Print watch on ${rows.length} printer${rows.length === 1 ? '' : 's'}: auto-pause ${on.length ? `on for ${on.join(', ')}` : 'off for all'}`
      return { summary, structured: { printers: rows, detector: guard ? guard.detector === true : null } }
    },
  })
}
