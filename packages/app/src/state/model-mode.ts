// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab's mode as the app shows it. An edition without modeling tools is always in Slice, even when a pref
// carried over from another edition says Design, and so is a phone: it views and prints, and modeling waits for the
// desktop. The saved mode is kept for when the same person opens a wider screen. A host that cannot slice (the CAD-only
// browser build) is the other way round: always in Model, on any screen.
import { editionHasCad, useEdition } from '../edition'
import { isPhoneLayout, usePhoneLayout } from '../lib/phone-layout'
import { appStore, get, set, setModelMode, useApp, type ModelMode } from './store'

/** Whether the host can slice; set once from its capabilities when the app starts (app.tsx). */
let slicing = true

export function setHostSlices(on: boolean): void {
  slicing = on
}

/** False in the CAD-only browser build: no Slice tab, no plate settings, no printing. */
export function hostSlices(): boolean {
  return slicing
}

/** Keeps the first tab in Model and the workspace on it; returns the unsubscribe. */
export function stayInModel(): () => void {
  const fix = () => {
    const s = get()
    if (s.modelMode !== 'design' || s.workspace !== 'prepare') set({ modelMode: 'design', workspace: 'prepare' })
  }
  fix()
  return appStore.subscribe(fix)
}

/** True when the modeling tools show: the edition has them and the screen isn't a phone, or the host only models. */
export function useCadShown(): boolean {
  const phone = usePhoneLayout()
  return !slicing || (editionHasCad(useEdition()) && !phone)
}

/** The same, read once, outside React. */
export function cadShown(): boolean {
  return !slicing || (editionHasCad() && !isPhoneLayout())
}

export function useModelMode(): ModelMode {
  const mode = useApp((s) => s.modelMode)
  const cad = useCadShown()
  if (!slicing) return 'design'
  return cad ? mode : 'slice'
}

export function modelMode(): ModelMode {
  if (!slicing) return 'design'
  return cadShown() ? get().modelMode : 'slice'
}

/** mimir and Model both show the design: the CAD look, the ground grid, the picks and the timeline. */
export function showsDesign(s: { workspace: string; modelMode: ModelMode }): boolean {
  return s.workspace === 'prepare' && (s.modelMode === 'design' || s.modelMode === 'mimir')
}

/** Ctrl+E (Cmd+E): the other mode, shown on the first tab from whichever tab is open. Does nothing without modeling tools. */
export function toggleModelMode(): void {
  if (slicing && cadShown()) setModelMode(get().modelMode === 'design' ? 'slice' : 'design')
}

/** Where the side panes keep their open state and widths: Design remembers its own, apart from Slice. */
export function railKey(workspace: string, mode: ModelMode): string {
  return workspace === 'prepare' && mode === 'design' ? 'prepare-design' : workspace
}
