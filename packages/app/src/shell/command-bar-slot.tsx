// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { lazy, useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { LazySlot } from './boundary'
import { CommandBarPending } from './command-bar-pending'

const CommandBar = lazy(() => import('./command-bar').then((m) => ({ default: m.CommandBar })))

/**
 * Cmd+K's palette, its ranking and its hub load as soon as the app has painted (so the palette is there by the time
 * anyone opens it), then stay mounted. On a slow machine the code may still be downloading when Cmd+K comes: the
 * stand-in palette is up in that same frame with its input focused, keeps what is typed, and the real bar takes over.
 */
export function CommandBarSlot() {
  const open = useApp((s) => s.commandOpen)
  const [used, setUsed] = useState(false)
  useEffect(() => {
    setUsed(true)
  }, [])
  return used || open ? (
    <LazySlot fallback={<CommandBarPending />}>
      <CommandBar />
    </LazySlot>
  ) : null
}
