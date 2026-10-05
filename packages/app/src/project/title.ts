// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop window title: the project's file, marked with * while it has unsaved changes.
import type { FileRef } from '@slicerx/contracts'
import { appStore, get } from '../state/store'
import { isDirty, onDirtyChange } from './unsaved'
import { appName } from '../edition'

export function windowTitle(file: Pick<FileRef, 'name' | 'path'> | null, dirty: boolean, app = appName()): string {
  const mark = dirty ? '*' : ''
  if (file) return `${mark}${file.path ?? file.name} · ${app}`
  return dirty ? `${mark}Untitled · ${app}` : app
}

/** Calls `cb` with the title now and whenever the file or the unsaved state changes. Returns a stop function. */
export function onWindowTitle(cb: (title: string) => void): () => void {
  let last = ''
  const emit = () => {
    const t = windowTitle(get().projectFile, isDirty())
    if (t !== last) cb((last = t))
  }
  const offStore = appStore.subscribe((s, prev) => {
    if (s.projectFile !== prev.projectFile) emit()
  })
  const offDirty = onDirtyChange(emit)
  return () => {
    offStore()
    offDirty()
  }
}
