// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BodyRevisionObserver } from '@slicerx/cad-history/body-revision-observer'
import { appStore } from '../state/store'

const observer = new BodyRevisionObserver()
observer.observe(appStore.getState().plate)
appStore.subscribe((state, before) => {
  if (state.plate !== before.plate) observer.observe(state.plate)
})

/** All app design hosts share one ledger so Undo cannot revive a stale face reference. */
export const bodyRevisions = observer.revisions
