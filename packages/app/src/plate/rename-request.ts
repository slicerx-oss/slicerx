// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Rename from outside the Model tree (the view's ring menu): the object's tree row opens its name field.
import { createStore } from 'zustand'

export const renameRequest = createStore<{ id: string | null }>()(() => ({ id: null }))

export function requestRename(id: string): void {
  renameRequest.setState({ id })
}

/** True once for the row the request is for, which takes it. */
export function takeRename(id: string): boolean {
  if (renameRequest.getState().id !== id) return false
  renameRequest.setState({ id: null })
  return true
}
