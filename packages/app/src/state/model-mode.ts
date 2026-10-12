// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab's mode as the app shows it. An edition without modeling tools is always in Slice, even when a pref
// carried over from another edition says Design, and so is a phone: it views and prints, and modeling waits for the
// desktop. The saved mode is kept for when the same person opens a wider screen. A host that cannot slice (the CAD-only
// browser build) is the other way round: always in Model, on any screen.
import { editionHasCad, useEdition } from '../edition'
import { isPhoneLayout, usePhoneLayout } from '../lib/phone-layout'
import { modelOrigin, type Vec3 } from '../plate/transform'
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

/** The workspaces a host that cannot slice may show; another non-slicing tab (mimir) joins here. */
export const MODEL_ONLY_WORKSPACES = new Set<string>(['prepare'])

/** Keeps the first tab off Slice and the workspace on one listed above; returns the unsubscribe. */
export function stayInModel(): () => void {
  const fix = () => {
    const s = get()
    const mode = s.modelMode === 'slice' ? 'design' : s.modelMode
    const workspace = MODEL_ONLY_WORKSPACES.has(s.workspace) ? s.workspace : 'prepare'
    if (mode !== s.modelMode || workspace !== s.workspace) set({ modelMode: mode, workspace })
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
  if (!slicing) return mode === 'slice' ? 'design' : mode
  return cad ? mode : 'slice'
}

export function modelMode(): ModelMode {
  const mode = get().modelMode
  if (!slicing) return mode === 'slice' ? 'design' : mode
  return cadShown() ? mode : 'slice'
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

/** Where the shown positions count from: the grid center in Model, the bed's front left corner in Slice. Display only. */
export function useShownOrigin(): { origin: Vec3; frame: 'grid' | 'bed' } {
  const model = useModelMode() === 'design'
  const bed = useApp((s) => s.bed)
  return model ? { origin: modelOrigin(bed), frame: 'grid' } : { origin: [0, 0, 0], frame: 'bed' }
}

/** Commands Model leaves out of the command bar (they still run from their shortcuts on a host that slices). */
export const SLICE_ONLY_COMMANDS: ReadonlySet<string> = new Set(['slice', 'slice-cancel', 'export-gcode', 'export-gcode-3mf', 'export-all-plates', 'gcode-lines'])

/** Whether the command bar lists a command in the mode shown. */
export function listedInMode(id: string, mode: ModelMode): boolean {
  if (!slicing && id === 'mode-slice') return false
  // the plate workspace's own Go to Slice would stay in Model; Go to Slice (mode-slice) is the one listed there
  if (id === 'open-prepare' && mode !== 'slice' && editionHasCad()) return false
  return mode === 'slice' || !SLICE_ONLY_COMMANDS.has(id)
}

/** Model's own words for commands that say bed in Slice. */
const MODEL_TITLES: Readonly<Record<string, string>> = {
  'center-object': 'Center the selected object on the grid',
  'drop-to-bed': 'Drop the selected object to the ground',
}

/** A command's title in the mode shown: grid and ground in Model, bed in Slice. */
export function titleInMode(id: string, title: string, mode: ModelMode): string {
  return (mode !== 'slice' && MODEL_TITLES[id]) || title
}
