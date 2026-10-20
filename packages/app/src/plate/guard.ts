// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every path that moves a printer goes through the same card: mimir's own upload, start and
// resume calls are wrapped here, so they get the send preflight and the bed-clear check the Send
// button has (docs/safety.md). The person's click on this card comes on top of mimir's token. When
// the person already ticked the bed and pressed Print on mimir's send card, its ledger entry for
// that request, printer and file skips this card once, after the preflight runs again.
import { developerModeRemedies, type ApprovalRequest, type FilamentSlot, type Host, type JobFile, type PrinterHost, type PrinterInfo, type RemoteFile, type SettingValue } from '@slicerx/contracts'
import { get, set } from '../state/store'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { formatDuration } from '../lib/preview-stats'
import type { SendLedger } from './send-ledger'

/** Shows the approval card as a confirmation. Resolves true only on Approve. */
function confirmCard(request: ApprovalRequest, extra: { checks?: { errors: string[]; warnings: string[] }; confirm?: string; go?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    set({
      approval: {
        requests: [request],
        ...extra,
        approve: async () => {
          set({ approval: null })
          resolve(true)
        },
        deny: async () => {
          set({ approval: null })
          resolve(false)
        },
      },
    })
  })
}

let seq = 0
const card = (title: string, lines: string[], printerId: string): ApprovalRequest => ({
  id: `guard_${Date.now().toString(36)}${(++seq).toString(36)}`,
  sessionId: 'app',
  tool: 'printer.guard',
  permission: 'start',
  title,
  lines,
  printerId,
  paramsHash: '',
  actions: [],
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})

async function preflightFor(printers: PrinterHost, printer: PrinterInfo, file: { name: string; sha256: string }, status: Awaited<ReturnType<PrinterHost['status']>> | null) {
  const [{ preflight }, { bounds }, { plateSliceConfig }] = await Promise.all([import('./preflight'), import('./transform'), import('../state/slice-plate')])
  const s = get()
  let pb: { min: [number, number, number]; max: [number, number, number] } | null = null
  for (const p of s.plate) {
    const b = bounds(p.parts, p.transform)
    if (!b) continue
    pb = pb ? { min: [0, 1, 2].map((i) => Math.min(pb!.min[i]!, b.min[i]!)) as [number, number, number], max: [0, 1, 2].map((i) => Math.max(pb!.max[i]!, b.max[i]!)) as [number, number, number] } : { min: [...b.min], max: [...b.max] }
  }
  const done = s.slice.status === 'done' ? s.slice.result : null
  return preflight({
    printer,
    status,
    // The config the plate was sliced with, filament slots included.
    config: plateSliceConfig(s, s.plates.find((p) => p.id === s.activePlate)) as Record<string, SettingValue | undefined>,
    plateBounds: pb,
    plateBed: s.bed,
    file: { name: file.name, sha256: file.sha256, layers: done?.layerCount ?? 0, timeS: done?.stats.timeS ?? 0, grams: done ? done.stats.filamentG.reduce((a, b) => a + b, 0) : 0 },
    ...(done?.collisions ? { collisions: done.collisions, objectNames: Object.fromEntries(s.plate.map((p) => [p.id, p.name])) } : {}),
  })
}

export const BED_CLEAR = 'The bed is clear and the right build plate is on it'
const BED_CLEAR_GO = 'Bed is clear, approve'

/** What the send card and the guard check before a file goes to a printer. Any error, a busy printer or Developer Mode off fails it. */
export interface SendCheck {
  facts: string[]
  errors: string[]
  warnings: string[]
  /** The printer's state when it is anything other than idle or finished. */
  busy: { state: string; timeLeftS?: number } | null
  /** The remedies for a Bambu Lab printer that takes no print from other apps (Developer Mode off). */
  developerMode: ReturnType<typeof developerModeRemedies> | null
  /** The printer's name, or its id when the app does not know it. */
  printerName: string
  /** The filament slots the printer reports, for the card's rows. */
  slots: FilamentSlot[]
}

/** The busy line, in place of the preflight's own, so the card says how long is left. */
export function busyLine(name: string, busy: { state: string; timeLeftS?: number }): string {
  const left = busy.timeLeftS !== undefined && busy.timeLeftS > 0 ? `, about ${formatDuration(busy.timeLeftS)} left` : ''
  return `${name} is ${busy.state}${left}. Pick another printer or wait until it finishes.`
}

/**
 * The preflight for a send, read fresh from the printer: the guard's checks plus the busy state and Developer Mode.
 * The send card shows it; the guard runs it again at upload time.
 */
export async function sendPreflight(printers: PrinterHost, printerId: string, file: { name: string; sha256: string }): Promise<SendCheck> {
  const printer = (await printers.list().catch(() => [])).find((p) => p.id === printerId)
  if (!printer) return { facts: [], errors: [`${printerId} is not connected.`], warnings: [], busy: null, developerMode: null, printerName: printerId, slots: [] }
  const status = await printers.status(printerId).catch(() => null)
  const check = await preflightFor(printers, printer, file, status)
  const errors = [...check.errors]
  const state = status?.state ?? 'offline'
  const busy = state === 'idle' || state === 'finished' ? null : { state, ...(status?.timeLeftS !== undefined ? { timeLeftS: status.timeLeftS } : {}) }
  // a printer at work says how long is left; offline and error keep the preflight's own words
  if (busy && state !== 'offline' && state !== 'error') {
    const at = errors.findIndex((e) => e.startsWith(`${printer.name} is busy`))
    const line = busyLine(printer.name, busy)
    if (at >= 0) errors[at] = line
    else errors.unshift(line)
  } else if (!status) errors.unshift(`${printer.name} is offline. Wait until it is idle.`)
  const devOff = status?.live?.needsDeveloperMode === true || status?.live?.monitorOnly === true
  if (devOff) errors.push(`${printer.name} turns away prints from other apps while Developer Mode is off.`)
  return { facts: check.facts, errors, warnings: check.warnings, busy, developerMode: devOff ? developerModeRemedies(status?.model ?? printer.model) : null, printerName: printer.name, slots: status?.slots ?? [] }
}

/**
 * The printers host mimir gets: reads pass through; upload and start run the preflight and ask
 * for the bed-clear check, resume asks to confirm the print is still in place. A no on the card
 * throws, so nothing reaches the printer. Every call goes to the host's printers as they are at
 * that moment, so the bridge coming back (it puts new printers in the host) needs no new runtime,
 * and a card answered after a reconnect sends through the live connection.
 */
export function guardedPrinters(host: Pick<Host, 'printers'>, opts: { ledger?: SendLedger } = {}): PrinterHost | undefined {
  const first = host.printers
  if (!first) return undefined
  const live = (): PrinterHost => host.printers ?? first
  // a key of the live host, its methods bound to it
  const delegate = (k: string | symbol): unknown => {
    const p = live()
    const v: unknown = Reflect.get(p, k)
    return typeof v === 'function' ? v.bind(p) : v
  }
  // the methods below read `printers` at each call, so it is the live host
  const printers = new Proxy({} as PrinterHost, { get: (_t, k) => delegate(k), has: (_t, k) => k in live() })
  const info = async (id: string) => (await printers.list()).find((p) => p.id === id)
  const refuse = () => {
    throw new Error('Not approved on the card. Nothing was sent to the printer.')
  }
  const uploaded = new Set<string>()
  const own: Pick<PrinterHost, 'upload' | 'start' | 'resume'> = {
    async upload(printerId: string, file: JobFile, token) {
      // The person ticked the bed and pressed Print on the send card for this request, printer and file: no second
      // card, but the preflight runs again now, and anything that fails refuses without a card.
      if (opts.ledger && token && opts.ledger.take(token.requestId, printerId, file.sha256)) {
        const check = await sendPreflight(printers, printerId, file)
        const first = check.errors[0]
        if (first !== undefined) throw new Error(`Preflight failed: ${first.replace(/\.$/, '')}. Nothing was sent to the printer.`)
        const remote = await printers.upload(printerId, file, token)
        // only an upload that went through lets the start skip its card
        uploaded.add(`${printerId}:${file.name}`)
        return remote
      }
      const p = await info(printerId)
      if (p) {
        const status = await printers.status(p.id).catch(() => null)
        const check = await preflightFor(printers, p, file, status)
        const ok = await confirmCard(card(`${ASSISTANT_NAME} wants to send ${file.name} to ${p.name}`, check.facts, printerId), { checks: { errors: check.errors, warnings: check.warnings }, confirm: BED_CLEAR, go: BED_CLEAR_GO })
        if (!ok) refuse()
        const remote = await printers.upload(printerId, file, token)
        uploaded.add(`${printerId}:${file.name}`)
        return remote
      }
      return printers.upload(printerId, file, token)
    },
    async start(file: RemoteFile, opts, token) {
      const p = await info(file.printerId)
      // An upload approved on this card a moment ago already had the bed-clear check.
      if (p && !uploaded.delete(`${file.printerId}:${file.name}`)) {
        const status = await printers.status(p.id).catch(() => null)
        const busy = status && !['idle', 'finished'].includes(status.state) ? [`${p.name} is ${status.state}. Wait until it is idle.`] : []
        const ok = await confirmCard(card(`${ASSISTANT_NAME} wants to start ${file.name} on ${p.name}`, [`${p.name}: ${p.vendor} ${p.model}`, `Starts ${file.name}: heats and moves the printer`], p.id), { checks: { errors: busy, warnings: [] }, confirm: BED_CLEAR, go: BED_CLEAR_GO })
        if (!ok) refuse()
      }
      return printers.start(file, opts, token)
    },
    async resume(printerId: string, token) {
      const p = await info(printerId)
      if (p) {
        const ok = await confirmCard(card(`${ASSISTANT_NAME} wants to resume ${p.name}`, [`${p.name}: ${p.vendor} ${p.model}`, 'Heats and continues the paused print'], printerId), { confirm: 'The paused print is still on the bed and nothing is in the way', go: 'Print is in place, resume' })
        if (!ok) refuse()
      }
      return printers.resume(printerId, token)
    },
  }
  // Every way of reading the host agrees with `get`: listing its keys, spreading it or reading a property's descriptor
  // gives the guarded upload, start and resume, never the live host's own. Nothing can be written onto it.
  const read = (k: string | symbol): unknown => (Object.hasOwn(own, k) ? own[k as keyof typeof own] : delegate(k))
  return new Proxy(own as PrinterHost, {
    get: (_t, k) => read(k),
    has: (_t, k) => Object.hasOwn(own, k) || k in live(),
    ownKeys: () => [...new Set([...Reflect.ownKeys(own), ...Reflect.ownKeys(live())])],
    getOwnPropertyDescriptor: (_t, k) => (Object.hasOwn(own, k) || Object.hasOwn(live(), k) ? { value: read(k), writable: false, enumerable: true, configurable: true } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}
