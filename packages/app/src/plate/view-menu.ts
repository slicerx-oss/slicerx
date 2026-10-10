// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the view's context menu for the selection is open, set by a right click on the plate and read by the menu in
// workspaces/prepare/selection-bar.tsx.
import { createStore } from 'zustand'

export const viewMenuStore = createStore<{ at: { x: number; y: number } | null }>()(() => ({ at: null }))

export function openViewMenu(x: number, y: number): void {
  viewMenuStore.setState({ at: { x, y } })
}

export function closeViewMenu(): void {
  viewMenuStore.setState({ at: null })
}
