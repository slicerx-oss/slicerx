// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { toolStore } from '../plate/tools'
import { get } from '../state/store'
import { LinkError } from './methods-error'

export const PREVIEW_BUSY_TOOLS = ['paint', 'brim', 'face']

/** View commands must not interrupt modeling or an active object tool. */
export function previewIdle(): void {
  const s = get()
  if (s.workspace !== 'prepare' || s.modelMode !== 'slice' || PREVIEW_BUSY_TOOLS.includes(toolStore.getState().tool)) {
    throw new LinkError('busy', 'the person is working elsewhere in the window; the preview moves only while Slice is open and no tool is in use')
  }
}
