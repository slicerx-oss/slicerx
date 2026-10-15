// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Status line and toasts. Dialogs load when they open.
import { StatusLine, useToast } from '@slicerx/ui'
import { useEffect } from 'react'
import { shownSlice, useApp } from '../state/store'
import { useLoading } from '../ravens/use-loading'

/**
 * One quiet slot for progress and warnings. Engine and graphics details live in About, under Diagnostics. The line
 * stays when it has nothing to say, so slicing and loading never change the height of the view above it.
 */
export function Status() {
  const slice = useApp((s) => s.slice)
  const loading = useApp((s) => s.plateLoading)
  const { words } = useLoading()
  const arranging = useApp((s) => s.arranging)
  const warnings = shownSlice(slice)?.result.warnings.length ?? 0
  const items = [
    ...(slice.status === 'running' ? ['Slicing'] : []),
    ...(loading ? [words] : []),
    ...(arranging ? [arranging.total ? `Arranging, layout ${Math.min(arranging.done + 1, arranging.total)} of ${arranging.total}` : 'Arranging'] : []),
    ...(warnings ? [`${warnings} ${warnings === 1 ? 'warning' : 'warnings'} in the last slice`] : []),
  ]
  return <StatusLine items={items} />
}

/** Actions outside React post toasts through the store; this hands them to the ui ToastProvider. */
export function ToastBridge() {
  const t = useApp((s) => s.toast)
  const toast = useToast()
  useEffect(() => {
    if (t) toast(t.text, { ...(t.tone ? { tone: t.tone } : {}), ...(t.action ? { action: t.action, duration: 8000 } : {}), ...(t.dismissible ? { dismissible: true } : {}), ...(t.onDismiss ? { onDismiss: t.onDismiss } : {}) })
  }, [t, toast])
  return null
}
