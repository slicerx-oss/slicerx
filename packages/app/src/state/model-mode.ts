// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab's mode as the app shows it. An edition without modeling tools is always in Slice, even when a pref
// carried over from another edition says Design.
import { editionHasCad, useEdition } from '../edition'
import { get, setModelMode, useApp, type ModelMode } from './store'

export function useModelMode(): ModelMode {
  const mode = useApp((s) => s.modelMode)
  return editionHasCad(useEdition()) ? mode : 'slice'
}

export function modelMode(): ModelMode {
  return editionHasCad() ? get().modelMode : 'slice'
}

/** Ctrl+E (Cmd+E): the other mode, shown on the first tab from whichever tab is open. Does nothing without modeling tools. */
export function toggleModelMode(): void {
  if (editionHasCad()) setModelMode(get().modelMode === 'design' ? 'slice' : 'design')
}

/** Where the side panes keep their open state and widths: Design remembers its own, apart from Slice. */
export function railKey(workspace: string, mode: ModelMode): string {
  return workspace === 'prepare' && mode === 'design' ? 'prepare-design' : workspace
}
