// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Listens for approvals the paired computer asks this phone to decide. They go into the store, so
// the Printers tab can badge the printer and its page can show the card; the sheet shows the rest.
// One answered somewhere else closes with a note (./answered).
import { useCallback, useEffect, useRef } from 'react'
import { ComputerApprovalSheet, type PendingComputerApproval } from '../components/computer-approval-sheet'
import { ComputerQuestionSheet } from '../components/computer-question-sheet'
import { notify } from '../notify/notifier'
import { answerComputerQuestion, openComputerApprovals, readComputerQuestion, watchComputerApprovals, watchComputerQuestions, watchResolvedApprovals, type ComputerApproval } from '../pair'
import { addWaiting, get, markAnswered, settleWaiting, updateQuestions, usePocket, type WaitingApproval } from '../state/store'
import { watchQuestions, type QuestionWatch } from './question-watch'
import { watchAnswered } from './answered'
import { forDisplay, relayBlock } from './verified-card'
import { checkWork, MISMATCH, type WorkCheck } from './work-card'
import { usePocketHost } from './provider'

export const IN_APP = 'Approve this in SlicerX on your computer'

/** The card is built from what the hub verified (printer, action, hash), never from the requester's own title or lines. */
export function toPending(a: ComputerApproval, names: Record<string, string> = {}, work: WorkCheck = { state: 'none' }): PendingComputerApproval {
  const base = forDisplay(a.view.request, a.view.source, names)
  // The hub's own summary of the work, checked against the card's hashes, words the card. One that does not match gets no Approve.
  const request = work.state === 'verified' ? { ...base, title: work.title, lines: work.lines } : base
  // A connected app's call (switching a Home Assistant device) is approved in SlicerX on the computer only; the hub refuses it from a phone.
  const inApp = a.view.request.actions.some((x) => x.action === 'plugin.call')
  const blocked = work.state === 'mismatch' ? MISMATCH : inApp ? IN_APP : relayBlock(a.view.request, a.via)
  const code = work.state === 'verified' ? work.code : undefined
  return { id: a.view.request.id, hostName: a.hostName, pairingId: a.pairingId, request, blocked, ...(code !== undefined ? { code } : {}), source: a.view.source, requestedBy: a.view.requestedBy, decide: a.decide }
}

export function ComputerApprovals() {
  const host = usePocketHost()
  const waiting = usePocket((s) => s.waiting)
  const openPrinterId = usePocket((s) => s.openPrinterId)
  const questions = usePocket((s) => s.questions)
  const questionWatch = useRef<QuestionWatch | null>(null)

  // The question mimir waits on in SlicerX on each paired computer: one card per computer, in the same sheet.
  useEffect(() => {
    const w = watchQuestions({
      onUpdate: (cb) => watchComputerQuestions(host, cb),
      read: (pairingId) => readComputerQuestion(host, pairingId),
      send: (pairingId, q, choiceId) => answerComputerQuestion(host, pairingId, q, choiceId),
      cards: () => get().questions,
      update: updateQuestions,
      onNew: (c) => {
        if (get().notify.approvals) notify({ title: 'mimir has a question', body: `${c.hostName} is waiting for your answer`, href: '/(tabs)' }).catch(() => undefined)
      },
    })
    questionWatch.current = w
    return () => {
      w.stop()
      questionWatch.current = null
    }
  }, [host])

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
      // A connected app's work comes under its own key (`connectedAppWork`), so older phones skip it.
      const viewWork = (a.view as { work?: unknown; connectedAppWork?: unknown }).work ?? (a.view as { connectedAppWork?: unknown }).connectedAppWork
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
  const answer = useCallback(async (pairingId: string, choiceId: string | null) => questionWatch.current?.answer(pairingId, choiceId), [])
  const closeQuestion = useCallback((pairingId: string) => questionWatch.current?.dismiss(pairingId), [])
  // An approval goes first; a question shows once no approval waits in the sheet.
  return forSheet.length > 0 ? <ComputerApprovalSheet pending={forSheet} onSettled={settle} /> : <ComputerQuestionSheet questions={questions} onAnswer={answer} onClose={closeQuestion} />
}
