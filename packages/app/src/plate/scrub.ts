// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A drag on a number field's scrub handle moves the object live. The moves on the way stay out of
// the undo history; the release is one step from where the drag started, and Escape puts the
// plate back as it was.
import { beginLiveEdit, endLiveEdit } from '../state/live-edit'
import { get, set, type PlateEntry } from '../state/store'
import { quietly } from './history'

let before: PlateEntry[] | null = null

const restore = () => {
  const plate = before
  before = null
  if (plate) quietly(() => set({ plate }))
}

/** Preview, cancel and commit for a scrub that edits object `id` through `apply`. */
export function plateScrub(id: string | null, apply: (v: number) => unknown) {
  return {
    onPreview(v: number) {
      // A locked object would say so on every move; it says so once, on release.
      if (get().plate.find((p) => p.id === id)?.locked) return
      before ??= get().plate
      beginLiveEdit()
      quietly(() => apply(v))
    },
    onCancel() {
      restore()
      endLiveEdit()
    },
    onCommit(v: number) {
      restore()
      apply(v)
      endLiveEdit()
    },
  }
}
