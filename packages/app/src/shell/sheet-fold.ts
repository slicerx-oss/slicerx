// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A docked phone sheet's fold, for the panel inside it: whether the sheet is folded to its header, a way to fold or
// open it, and a spot in the header where the panel puts a short summary of itself (the sketch's tool and state), so a
// folded sheet still says what the tool is doing and has a plain button to open it again.
import { createContext, useContext } from 'react'

export interface SheetFold {
  folded: boolean
  setFolded: (folded: boolean) => void
  /** The header's summary spot, or null until it mounts. */
  slot: HTMLElement | null
}

export const SheetFoldContext = createContext<SheetFold | null>(null)

/** The docked sheet the panel sits in, or null outside one (a desktop, or a sheet that isn't docked). */
export const useSheetFold = (): SheetFold | null => useContext(SheetFoldContext)
