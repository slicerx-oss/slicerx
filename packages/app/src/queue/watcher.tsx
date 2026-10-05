// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tells the person when a queued plate's time has come. It only tells: the start is theirs to approve.
import { useEffect, useRef } from 'react'
import { get, setWorkspace, toast } from '../state/store'
import { dueItems } from './queue'

export function QueueWatcher() {
  const told = useRef(new Set<string>())
  useEffect(() => {
    const check = () => {
      for (const q of dueItems(get().queue)) {
        if (told.current.has(q.id)) continue
        told.current.add(q.id)
        toast(`${q.plateName} is ready to start on ${q.printerName}. Open Printers to start it.`, 'info')
      }
    }
    check()
    const t = window.setInterval(check, 30_000)
    return () => window.clearInterval(t)
  }, [])
  return null
}

/** Open the Printers page, where the queue lives. */
export function showQueue(): void {
  setWorkspace('printers')
}
