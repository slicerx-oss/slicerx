// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's print run read back over the app link (mimir.run): for one chat, where the run stands step by step, the last
// slice, what was sent and the print as the printer last reported it. Read live from the tab's runtime, which follows the
// print's layer, progress and time left, and from the last print_run event in the chat's session log (the same log
// mimir.session reads) when the runtime holds nothing for the chat. Printers go by the name the person gave them. The file, its SHA-256,
// approval tokens, request ids, printer ids (a serial on some printers), access codes and addresses stay in the app:
// only the fields below are copied out. Nothing here starts, queues or approves a print.
import { assistantText } from '@slicerx/contracts'
import type { Host, PilotEvent, PrinterHost, PrintRun, RunStepName } from '@slicerx/contracts'
import { emptyRun, runSteps } from '@slicerx/pilot'
import { currentEdition } from '../edition'
import { editionToolGroups } from '../pilot-connect/brain'
import { LinkError } from './methods-error'
import { currentTabChat, sessionSource } from './sessions'

/** The app's answer to mimir.run. */
export interface RunRead {
  sessionId: string
  steps: { name: RunStepName; state: 'done' | 'now' | 'todo' | 'off' }[]
  slice: { timeS: number; grams: number; cost: number; warnings: string[]; stale: boolean } | null
  send: { printerName: string; fileName: string; slots: { filament: number; slot: string }[] } | null
  print: { printerName: string; state: string; layer: number | null; layerCount: number | null; timeLeftS: number | null; progress: number | null; outcome: 'finished' | 'failed' | 'canceled' | null } | null
}

let printers: (() => PrinterHost | undefined) | null = null

/** Gives the read-back the window's printers, for their names; returns how to take them away. */
export function bindRunPrinters(host: Pick<Host, 'printers'> | undefined): () => void {
  const mine = host ? () => host.printers : null
  printers = mine
  return () => {
    if (printers === mine) printers = null
  }
}

const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}...` : t)
const num = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The name each printer is shown by, by id. A printer the app no longer knows gets no name, never its id. */
export async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const host = printers?.()
  if (!host || ids.length === 0) return out
  try {
    for (const p of await host.list()) {
      // a name that only repeats the id would carry a serial out
      if (ids.includes(p.id) && !p.name.includes(p.id)) out.set(p.id, cut(p.name, 120))
    }
  } catch {
    // no names when the printers cannot be listed
  }
  return out
}

/** Whether the runtime holds anything for the chat: an empty run is one it never had, or one a new chat dropped. */
const held = (run: PrintRun | null | undefined): run is PrintRun => !!run && (run.designId !== null || run.printerId !== null || run.slice !== null || run.send !== null || run.job !== null)

/** The chat's last print run in its log, or an empty one for a chat with none yet. */
function lastRun(sessionId: string, events: readonly PilotEvent[]): PrintRun {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'print_run') return e.run
  }
  return emptyRun(sessionId, new Date().toISOString())
}

/**
 * `mimir.run {sessionId?}`: one chat's print run, the chat the tab has open unless sessionId names another (the newest
 * mimir session when the tab has not opened one); null before the tab first opens. A new chat with nothing said yet
 * reads as an empty run of its own, never the last chat's.
 */
export async function readRun(args: Record<string, unknown>): Promise<RunRead | null> {
  const asked = args['sessionId']
  if (asked !== undefined && (typeof asked !== 'string' || !asked || asked.length > 200)) throw new LinkError('invalid_input', assistantText('sessionId is a session id from mimir.sessions'))
  const source = sessionSource()
  if (!source) return null
  const sessions = await source.store.list()
  let id: string
  if (typeof asked === 'string') {
    if (!sessions.some((s) => s.id === asked)) throw new LinkError('not_found', assistantText(`no mimir session ${asked}`))
    id = asked
  } else if (currentTabChat()) {
    id = currentTabChat()!
  } else {
    // with no sessionId and no chat open in the tab, the newest mimir session
    const newest = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    if (!newest) return { sessionId: '', steps: runSteps(emptyRun('', new Date().toISOString()), editionToolGroups(currentEdition())), slice: null, send: null, print: null }
    id = newest.id
  }
  // live while the runtime holds the chat, so a print going shows its layer and time left; else as the log last had it
  const live = source.run?.(id)
  const run = held(live) ? live : lastRun(id, await source.store.read(id))
  const names = await namesOf([run.send?.printerId, run.job?.printerId].filter((p): p is string => typeof p === 'string'))
  const nameOf = (printerId: string): string => names.get(printerId) ?? ''
  const { slice, send, job } = run
  return {
    sessionId: id,
    steps: runSteps(run, editionToolGroups(currentEdition())),
    slice: slice ? { timeS: slice.timeS, grams: slice.grams, cost: slice.cost, warnings: slice.warnings.slice(0, 20).map((w) => cut(w, 300)), stale: slice.stale === true } : null,
    send: send
      ? {
          printerName: nameOf(send.printerId),
          fileName: cut(send.fileName, 200),
          slots: Object.entries(send.slots)
            .map(([k, v]) => ({ filament: Number(k), slot: String(v) }))
            .sort((a, b) => a.filament - b.filament),
        }
      : null,
    print: job ? { printerName: nameOf(job.printerId), state: job.state, layer: num(job.layer), layerCount: num(job.layerCount), timeLeftS: num(job.timeLeftS), progress: num(job.progress), outcome: job.outcome ?? null } : null,
  }
}
