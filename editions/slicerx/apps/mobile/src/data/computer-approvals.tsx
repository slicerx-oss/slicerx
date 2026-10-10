// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Listens for approvals the paired computer asks this phone to decide. They go into the store, so
// the Printers tab can badge the printer and its page can show the card; the sheet shows the rest.
// One answered somewhere else closes with a note (./answered).
import { useCallback, useEffect } from 'react'
import { ComputerApprovalSheet, type PendingComputerApproval } from '../components/computer-approval-sheet'
import { notify } from '../notify/notifier'
import { openComputerApprovals, watchComputerApprovals, watchResolvedApprovals, type ComputerApproval } from '../pair'
import { addWaiting, get, markAnswered, settleWaiting, usePocket, type WaitingApproval } from '../state/store'
import { watchAnswered } from './answered'
import { forDisplay, relayBlock } from './verified-card'
import { checkWork, MISMATCH, type WorkCheck } from './work-card'
import { usePocketHost } from './provider'

/** The card is built from what the hub verified (printer, action, hash), never from the requester's own title or lines. */
export function toPending(a: ComputerApproval, names: Record<string, string> = {}, work: WorkCheck = { state: 'none' }): PendingComputerApproval {
  const base = forDisplay(a.view.request, a.view.source, names)
  // The hub's own summary of the work, checked against the card's hashes, words the card. One that does not match gets no Approve.
  const request = work.state === 'verified' ? { ...base, title: work.title, lines: work.lines } : base
  const blocked = work.state === 'mismatch' ? MISMATCH : relayBlock(a.view.request, a.via)
  const code = work.state === 'verified' ? work.code : undefined
  return { id: a.view.request.id, hostName: a.hostName, pairingId: a.pairingId, request, blocked, ...(code !== undefined ? { code } : {}), source: a.view.source, requestedBy: a.view.requestedBy, decide: a.decide }
}

export function ComputerApprovals() {
  const host = usePocketHost()
  const waiting = usePocket((s) => s.waiting)
  const openPrinterId = usePocket((s) => s.openPrinterId)

  useEffect(() => {
    const answered = watchAnswered({
      onResolved: (cb) => watchResolvedApprovals(host, cb),
      openIds: (pairingId) => openComputerApprovals(host, pairingId),
      waiting: () => get().waiting,
      markAnswered,
      settle: settleWaiting,
    })
    const off = watchComputerApprovals(host, async (a) => {
      // Printer names make the card readable; an unknown printer shows its id.
      const names: Record<string, string> = {}
      for (const p of await host.printers.list().catch(() => [])) names[p.id] = p.name
      // The hub sends its checked work next to the request (not inside it, so the signed hash is unchanged).
      const viewWork = (a.view as { work?: unknown }).work
      const work = await checkWork(viewWork === undefined ? a.view.request : ({ ...a.view.request, work: viewWork } as typeof a.view.request), (id) => names[id] ?? id).catch((): WorkCheck => ({ state: 'mismatch' }))
      const p = answered.own(toPending(a, names, work))
      // A request that already ran out, or was answered meanwhile, is not worth showing; a repeat of one on screen is ignored.
      if (Date.parse(p.request.expiresAt) <= Date.now() || answered.gone(p.id)) return
      addWaiting(p)
      if (get().notify.approvals) {
        const href = p.request.printerId ? `/printer/${p.request.printerId}` : '/(tabs)'
        notify({ title: 'Approval waiting', body: `${a.hostName} is waiting for your answer`, href }).catch(() => undefined)
      }
    })
    return () => {
      off()
      answered.stop()
    }
  }, [host])

  // Expired requests drop out on their own.
  useEffect(() => {
    if (waiting.length === 0) return undefined
    const id = setInterval(() => {
      const now = Date.now()
      for (const w of get().waiting) if (Date.parse(w.request.expiresAt) + 500 <= now) settleWaiting(w.id)
    }, 1000)
    return () => clearInterval(id)
  }, [waiting.length])

  const settle = useCallback((id: string) => settleWaiting(id), [])
  // The printer page on screen shows its own cards inline.
  const forSheet: WaitingApproval[] = openPrinterId ? waiting.filter((w) => w.request.printerId !== openPrinterId) : waiting
  return <ComputerApprovalSheet pending={forSheet} onSettled={settle} />
}
