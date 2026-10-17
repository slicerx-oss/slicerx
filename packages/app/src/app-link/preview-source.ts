// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Host } from '@slicerx/contracts'

let current: { host: Host } | null = null

/** Only the window hosting the app link supplies its platform's slice text reader. */
export function bindPreviewSource(host?: Host): () => void {
  const owner = host ? { host } : null
  current = owner
  return () => { if (current === owner) current = null }
}

export function previewSource() {
  return current
}
