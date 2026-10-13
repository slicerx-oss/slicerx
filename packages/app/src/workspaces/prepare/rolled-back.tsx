// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The notice under Print and Export while the design's timeline is rolled back: slicing uses that state, so it is
// said plainly, with the way back to the end next to it.
import { Button } from '@slicerx/ui'
import { useState } from 'react'
import { useHost } from '../../host'
import { rolledBackNote } from '../../plate/timeline'
import { get, toast, useApp } from '../../state/store'

export function RolledBack() {
  const host = useHost()
  const note = useApp(rolledBackNote)
  const [busy, setBusy] = useState(false)
  if (!note) return null
  const toEnd = async () => {
    setBusy(true)
    try {
      const { rollTo } = await import('../../cad/history/rollback')
      await rollTo(host.slicer, get().timeline.items.length)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'warn')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="app-note prose rolled-back" role="status" data-testid="rolled-back">
      <p>{note}</p>
      <Button size="sm" variant="ghost" icon="chevron-right" disabled={busy} onClick={() => void toEnd()}>
        Move to the end
      </Button>
    </div>
  )
}
