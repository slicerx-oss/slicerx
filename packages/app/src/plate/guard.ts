// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every path that moves a printer goes through the same card: mimir's own upload, start and
// resume calls are wrapped here, so they get the send preflight and the bed-clear check the Send
// button has (docs/safety.md). The person's click on this card comes on top of mimir's token.
import type { ApprovalRequest, Host, JobFile, PrinterHost, PrinterInfo, RemoteFile, SettingValue } from '@slicerx/contracts'
import { get, set } from '../state/store'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'

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

async function preflightFor(printers: PrinterHost, printer: PrinterInfo, file: { name: string; sha256: string }) {
  const [{ preflight }, { bounds }, { plateSliceConfig }] = await Promise.all([import('./preflight'), import('./transform'), import('../state/actions')])
  const s = get()
  const status = await printers.status(printer.id).catch(() => null)
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
    ...(done?.collisions ? { collisions: done.collisions } : {}),
  })
}

const BED_CLEAR = 'The bed is clear and the right build plate is on it'
const BED_CLEAR_GO = 'Bed is clear, approve'

/**
 * The printers host mimir gets: reads pass through; upload and start run the preflight and ask
 * for the bed-clear check, resume asks to confirm the print is still in place. A no on the card
 * throws, so nothing reaches the printer.
 */
export function guardedPrinters(host: Pick<Host, 'printers'>): PrinterHost | undefined {
  const printers = host.printers
  if (!printers) return undefined
  const info = async (id: string) => (await printers.list()).find((p) => p.id === id)
  const refuse = () => {
    throw new Error('Not approved on the card. Nothing was sent to the printer.')
  }
  const uploaded = new Set<string>()
  return {
    ...printers,
    async upload(printerId: string, file: JobFile, token) {
      const p = await info(printerId)
      if (p) {
        const check = await preflightFor(printers, p, file)
        const ok = await confirmCard(card(`${ASSISTANT_NAME} wants to send ${file.name} to ${p.name}`, check.facts, printerId), { checks: { errors: check.errors, warnings: check.warnings }, confirm: BED_CLEAR, go: BED_CLEAR_GO })
        if (!ok) refuse()
        uploaded.add(`${printerId}:${file.name}`)
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
}
