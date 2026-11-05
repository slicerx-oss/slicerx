// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One connection to a paired computer, hooked up for mimir's questions: only a computer that offers them (host.info
// mimir) to a phone with the approve right there. Its changes and a first read go to `tell`, and when the connection
// closes the card hears the computer is out of reach. Returns how to stop listening.
import type { HostConnection, MimirEnded, MimirQuestion } from '@slicerx/pair'

/** A paired computer's word on the question mimir waits on there (approver phones only). */
export interface ComputerQuestion {
  pairingId: string
  hostName: string
  live: boolean
  waiting: MimirQuestion | null
  ended?: MimirEnded | undefined
  /** False once the connection dropped. */
  reachable?: boolean | undefined
}

/** A computer that hands this phone its mimir questions: it says so, and this phone may approve there. */
export const asksQuestions = (conn: Pick<HostConnection, 'info'>): boolean => conn.info.mimir === true && conn.info.rights.approve

export function hookQuestions(conn: Pick<HostConnection, 'info' | 'on' | 'onClose' | 'mimirQuestions'>, pairingId: string, tell: (q: ComputerQuestion) => void): () => void {
  if (!asksQuestions(conn)) return () => undefined
  const hostName = conn.info.identity.name
  let on = true
  const offEvent = conn.on('mimir.question', (st) => on && tell({ pairingId, hostName, ...st }))
  const offClose = conn.onClose(() => on && tell({ pairingId, hostName, live: false, waiting: null, reachable: false }))
  conn.mimirQuestions().then(
    (st) => on && tell({ pairingId, hostName, ...st }),
    () => undefined,
  )
  return () => {
    on = false
    offEvent()
    offClose()
  }
}
