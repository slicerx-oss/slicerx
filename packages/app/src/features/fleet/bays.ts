// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moving a printer between bays. A bay lives while it holds a printer: moving the last one out drops it,
// so there is no separate page to tidy bays up.
import { set } from '../../state/store'
import { newBayId } from './wall'

/** Puts the printer in the bay, or in none with null. */
export function moveToBay(printerId: string, bayId: string | null): void {
  set((s) => {
    const printerBays = { ...s.printerBays }
    const was = printerBays[printerId]
    if (bayId) printerBays[printerId] = bayId
    else delete printerBays[printerId]
    const emptied = was && was !== bayId && !Object.values(printerBays).includes(was)
    return { printerBays, ...(emptied ? { bays: s.bays.filter((b) => b.id !== was) } : {}) }
  })
}

/** Makes a bay and puts the printer in it. Returns the new bay's id. */
export function newBay(printerId: string, name: string, place: string): string {
  let id = ''
  set((s) => {
    id = newBayId(s.bays, name)
    return { bays: [...s.bays, { id, name: name.trim(), ...(place.trim() ? { place: place.trim() } : {}) }] }
  })
  moveToBay(printerId, id)
  return id
}
