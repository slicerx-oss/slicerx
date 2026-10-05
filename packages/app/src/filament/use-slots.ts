// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useMemo } from 'react'
import { useApp } from '../state/store'
import { resolveSlots, type ResolvedSlot } from './slots'

/** The slots as the panel and dialogs show them. Built from the store's pieces, since a selector that returns a new array every call would loop. */
export function useResolvedSlots(): ResolvedSlot[] {
  const printerSlots = useApp((s) => s.printerSlots)
  const plates = useApp((s) => s.plates)
  const plate = useApp((s) => s.plate)
  const activePlate = useApp((s) => s.activePlate)
  const slotSetup = useApp((s) => s.slotSetup)
  const slotMatch = useApp((s) => s.slotMatch)
  return useMemo(() => resolveSlots({ printerSlots, plates, plate, activePlate, slotSetup, slotMatch }), [printerSlots, plates, plate, activePlate, slotSetup, slotMatch])
}
