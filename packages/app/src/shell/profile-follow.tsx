// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tells the slice which printer model it is for: the printer shown in the sidebar (the selected one, else the first
// idle one), so its bed, speeds, limits and G-code follow the machine.
import { useEffect } from 'react'
import { set } from '../state/store'
import type { FleetRow } from '../lib/queries'
import { useShownPrinterPick } from '../lib/use-printer'

/** What the slice follows from the shown printer. Its temperatures and progress change nothing here. */
function followed(printer: FleetRow | undefined) {
  return { id: printer?.id, vendor: printer?.vendor, model: printer?.model, reported: printer?.status.nozzleDiameterMm }
}

export function ProfileFollow() {
  const { vendor, model, id, reported } = useShownPrinterPick(followed)
  useEffect(() => {
    // The sync loads after first paint; it reads the store as it is then, so nothing set before it is missed.
    void import('../state/profile-sync').then((m) => m.startProfileSync())
    void import('../project/project-printer').then((m) => m.startProjectPrinterSync())
  }, [])
  useEffect(() => {
    set({ printerModel: vendor && model ? { ...(id ? { id } : {}), vendor, model } : null })
  }, [vendor, model, id])
  // A printer that reports its nozzle gives the size; that wins over what was chosen.
  useEffect(() => {
    if (!id) return
    set((s) => {
      if (s.nozzleReported[id] === reported) return {}
      const next = { ...s.nozzleReported }
      if (reported) next[id] = reported
      else delete next[id]
      return { nozzleReported: next }
    })
  }, [id, reported])
  return null
}
