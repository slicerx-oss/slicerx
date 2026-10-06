// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loaded only where the desktop shell registered an updater: starts the checks and shows the dialog when it opens.
// The Print sheet and the approval card hold Restart to update; first run and the agreement keep the dialog from
// opening by itself.
import { useEffect } from 'react'
import { appStore, get } from '../state/store'
import { UpdateDialog } from './dialog'
import { notifyBusy, startUpdates, useUpdateOpen, watchBusy } from './updates'

export function UpdatesRoot() {
  const open = useUpdateOpen()
  useEffect(() => {
    watchBusy(
      () => get().printSheet !== null || get().approval !== null,
      () => get().setup !== null || get().agreementOpen,
    )
    const stop = startUpdates()
    const unwatch = appStore.subscribe((s, prev) => {
      if (s.printSheet !== prev.printSheet || s.approval !== prev.approval || s.setup !== prev.setup || s.agreementOpen !== prev.agreementOpen) notifyBusy()
    })
    return () => {
      stop()
      unwatch()
    }
  }, [])
  return open ? <UpdateDialog /> : null
}
