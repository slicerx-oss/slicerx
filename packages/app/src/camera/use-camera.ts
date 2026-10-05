// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer's camera for a view: the stream session, and in snapshot mode a new still every two
// seconds. The camera player and the device view both show a camera through this.
import type { PrinterInfo } from '@slicerx/contracts'
import { useEffect, useRef, useState } from 'react'
import { useHost } from '../host'
import { get } from '../state/store'
import { takeViewClosing } from './closing'
import { cameraStreams, type CameraSession, type CameraStatus, type Quality } from './stream'

/** Why a view's stream closes, in plain words for the bridge's connection log. */
function closeReason(unmounting: boolean): string {
  if (!unmounting) return 'the view changed printer, quality or camera availability'
  const noted = takeViewClosing()
  if (noted) return noted
  const s = get()
  if (s.setup !== null) return 'setup opened over the app'
  if (s.agreementOpen) return 'the agreement opened over the app'
  if (s.workspace !== 'printers') return `the app switched to ${s.workspace}`
  return 'the view unmounted for another reason'
}

/** The last still seen of each printer, so a view of a printer whose camera is gone can still show it. */
const lastStill = new Map<string, Blob>()

export function lastStillOf(printerId: string): Blob | undefined {
  return lastStill.get(printerId)
}

/** Keeps a still seen elsewhere (a tile on Printers), so a view opened later can show it too. */
export function rememberStill(printerId: string, blob: Blob): void {
  lastStill.set(printerId, blob)
}

/**
 * Where a view's camera stands: `connecting` until a session opens, then the session's own state,
 * `live` or `retrying` (the bridge tries a camera that dropped the connection again).
 */
export type CameraViewStatus = { state: 'connecting' } | CameraStatus

export function useCamera(printer: Pick<PrinterInfo, 'id' | 'name'> | null, quality: Quality = 'medium'): { session: CameraSession | null; error: string; still: string; status: CameraViewStatus } {
  const host = useHost()
  const [session, setSession] = useState<CameraSession | null>(null)
  const [error, setError] = useState('')
  const [still, setStill] = useState('')
  const [status, setStatus] = useState<CameraViewStatus>({ state: 'connecting' })
  const id = printer?.id
  const name = printer?.name

  // Set while the view unmounts, so the stream's close can say why in the bridge's log. Declared
  // before the stream effect, so its cleanup runs first.
  const leaving = useRef(false)
  useEffect(() => {
    leaving.current = false
    return () => {
      leaving.current = true
    }
  }, [])

  useEffect(() => {
    if (!id || !name) return
    const abort = new AbortController()
    let live: CameraSession | null = null
    let offProblem: (() => void) | undefined
    let offStatus: (() => void) | undefined
    setError('')
    setSession(null)
    setStatus({ state: 'connecting' })
    void cameraStreams(host)
      .open({ id, name }, { quality, signal: abort.signal })
      .then((s) => {
        if (abort.signal.aborted) return s.close('opened after the view moved on')
        live = s
        setSession(s)
        // A live session that shows no picture says why, the same way a failed start does.
        offProblem = s.onProblem?.(setError)
        if (s.onStatus) offStatus = s.onStatus(setStatus)
        else setStatus({ state: 'live' })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'The camera did not start'))
    return () => {
      abort.abort()
      offProblem?.()
      offStatus?.()
      live?.close(closeReason(leaving.current))
    }
  }, [id, name, host, quality])

  // Snapshot mode: a new still every two seconds.
  useEffect(() => {
    if (!id || !session || session.mode !== 'snapshot' || !session.snapshot) return
    let url = ''
    let stop = false
    const tick = async () => {
      const blob = await session.snapshot!()
      if (stop || !blob) return
      lastStill.set(id, blob)
      const next = URL.createObjectURL(blob)
      setStill(next)
      if (url) URL.revokeObjectURL(url)
      url = next
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
      if (url) URL.revokeObjectURL(url)
      setStill('')
    }
  }, [session, id])

  return { session, error, still, status }
}
