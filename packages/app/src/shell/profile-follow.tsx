// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tells the slice which printer model it is for: the printer shown in the sidebar (the selected one, else the first
// idle one), so its bed, speeds, limits and G-code follow the machine.
import { useEffect } from 'react'
import { startProfileSync } from '../state/profile-sync'
import { set } from '../state/store'
import { usePrinter } from '../lib/use-printer'

export function ProfileFollow() {
  const { printer } = usePrinter()
  const vendor = printer?.vendor
  const model = printer?.model
  const id = printer?.id
  const reported = printer?.status.nozzleDiameterMm
  useEffect(() => {
    startProfileSync()
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
