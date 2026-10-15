// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview of the Model tool the person has open (push and pull, fillet and chamfer), over the app link:
// whether the last edit previewed or failed, the error the person reads next to the tool, whether the view is keeping
// the last good preview through that error, and whether what it shows adds or removes material. Read only.
import { get } from '../state/store'
import { previewReport } from '../cad/op-preview'

const TOOLS: Record<string, string> = { push: 'push', fillet: 'fillet' }

/** The open tool's preview; `open` is false while no tool that previews is open. */
export function readOpPreview() {
  const r = previewReport()
  const tool = get().objectTool
  const open = r !== null && tool !== null && TOOLS[tool] !== undefined
  if (!open || !r) return { open: false as const, tool: null, status: 'none' as const, message: null, showingLastGood: false, adds: false, removes: false }
  return { open: true as const, ...r }
}
