// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the part card and its next steps do in the app: each acts on the part its reply made, by id.
import type { PartHandlers } from '@slicerx/pilot/ui'
import { beginEdit, toolFor } from '../../cad/history/ops'
import { fullPlate, get, set, setModelMode } from '../../state/store'
import { openTransform } from '../prepare/selection-bar'

type Loader = Parameters<typeof beginEdit>[0]

/** Select the part on the plate, which highlights it. */
export function selectPart(id: string): void {
  set({ selection: id, selectedIds: [id], towerSelected: false })
}

/** True while the part is in the project, including while one of its steps is open for editing. */
export function hasPart(id: string): boolean {
  return fullPlate(get()).some((e) => e.id === id)
}

/**
 * Opens the part for editing in Model, where hands-on editing happens: its newest modeling step in that step's tool,
 * or else the selection's Transform. The tab is one click away.
 */
export async function editPart(host: Loader, id: string): Promise<void> {
  const e = get().plate.find((p) => p.id === id)
  setModelMode('design')
  const steps = e?.history?.steps ?? []
  let index = -1
  for (let i = steps.length - 1; i >= 0 && index < 0; i--) if (toolFor(steps[i]!.params)) index = i
  if (e && index >= 0) return beginEdit(host, id, index)
  selectPart(id)
  openTransform()
}

/** Edit's tooltip: it leaves the tab for Model. */
export const EDIT_TIP = { title: 'Edit in Model', body: 'Opens the part in Model at its newest step, to change it by hand.' }

/**
 * The card's and steps' actions. Select stays in the tab; Edit goes to Model. A phone has no modeling tools, so its
 * card has no Edit; the body still selects.
 */
export function partHandlers(host: Loader, phone: boolean): PartHandlers {
  return { ...(phone ? {} : { onEdit: (id: string) => void editPart(host, id), editTip: EDIT_TIP }), onSelect: selectPart, has: hasPart }
}
