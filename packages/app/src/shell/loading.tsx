// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What shows while a part of the app loads (a workspace, a settings page, the assistant): a moving sheen over the
// space it will fill and, once the wait passes a moment, the word Loading, so a slow load never reads as an empty page.

export function Loading() {
  return (
    <div className="ws-loading" role="status" aria-busy="true">
      <span>Loading</span>
    </div>
  )
}
