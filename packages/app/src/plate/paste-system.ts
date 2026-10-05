// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paste from the system clipboard: model files (STL, 3MF, .sx3mf, OBJ, AMF, STEP) that a file manager or another app put there open
// as if dropped on the window. With no model file on it, the paste is the app's own clipboard.
import type { Host } from '@slicerx/contracts'
import { runCommand } from '../commands/registry'
import { openModelBytes } from '../state/actions'
import { toast } from '../state/store'

const MODEL = /\.(stl|3mf|sx3mf|obj|amf|step|stp)$/i

export function modelFilesOf(e: Pick<ClipboardEvent, 'clipboardData'>): File[] {
  return [...(e.clipboardData?.files ?? [])].filter((f) => MODEL.test(f.name))
}

export async function pasteFromSystem(host: Host, e: ClipboardEvent): Promise<void> {
  const files = modelFilesOf(e)
  if (files.length === 0) {
    await runCommand('paste')
    return
  }
  for (const f of files) {
    if (f.size > 512 * 1024 * 1024) {
      toast(`${f.name} is too large to paste.`, 'warn')
      continue
    }
    await openModelBytes(host, f.name, await f.arrayBuffer())
  }
}
