// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab's mode as the app shows it. An edition without modeling tools is always in Slice, even when a pref
// carried over from another edition says Design, and so is a phone: it views and prints, and modeling waits for the
// desktop. The saved mode is kept for when the same person opens a wider screen.
import { editionHasCad, useEdition } from '../edition'
import { isPhoneLayout, usePhoneLayout } from '../lib/phone-layout'
import { get, setModelMode, useApp, type ModelMode } from './store'

/** True when the modeling tools show: the edition has them and the screen isn't a phone. */
export function useCadShown(): boolean {
  const phone = usePhoneLayout()
  return editionHasCad(useEdition()) && !phone
}

/** The same, read once, outside React. */
export function cadShown(): boolean {
  return editionHasCad() && !isPhoneLayout()
}

export function useModelMode(): ModelMode {
  const mode = useApp((s) => s.modelMode)
  return useCadShown() ? mode : 'slice'
}

export function modelMode(): ModelMode {
  return cadShown() ? get().modelMode : 'slice'
}

/** Ctrl+E (Cmd+E): the other mode, shown on the first tab from whichever tab is open. Does nothing without modeling tools. */
export function toggleModelMode(): void {
  if (cadShown()) setModelMode(get().modelMode === 'design' ? 'slice' : 'design')
}

/** Where the side panes keep their open state and widths: Design remembers its own, apart from Slice. */
export function railKey(workspace: string, mode: ModelMode): string {
  return workspace === 'prepare' && mode === 'design' ? 'prepare-design' : workspace
}
