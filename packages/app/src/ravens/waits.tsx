// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Huginn and Muninn keeping company through the longer waits: muninn rides the Estimate block's slicing bar, the two fly in
// over the plate while a big model loads, and one carries the file while an upload goes up. Loaded only once a wait
// has run past about 1.2 s (lib/waited.ts), so the art never weighs on the start. Under reduced motion they keep
// still where they would be.
import { Icon, Raven } from '@slicerx/ui'
import './waits.css'

/** Muninn riding the slicing bar at the fill's edge; with `done` it flies off. */
export function SliceGlide({ done }: { done: boolean }) {
  return (
    <span className="rv-glide" data-done={done || undefined} data-testid="raven-slice-glide" aria-hidden="true">
      <Raven size={24} flap={!done} facing="right" />
    </span>
  )
}

/** The two ravens circling over the plate while a model loads; `leaving` sends them off once it is on the plate. */
export function LoadingRavens({ leaving }: { leaving: boolean }) {
  return (
    <div className="rv-loading" data-leaving={leaving || undefined} data-testid="raven-loading" aria-hidden="true">
      <span className="rv-loading-arm">
        <Raven size={36} flap facing="right" />
      </span>
      <span className="rv-loading-arm rv-loading-late">
        <Raven size={32} flap facing="left" />
      </span>
    </div>
  )
}

/** A raven carrying the file across, beside the upload's status line. */
export function UploadCarry() {
  return (
    <span className="rv-carry" data-testid="raven-upload-carry" aria-hidden="true">
      <span className="rv-carry-bird">
        <Raven size={20} flap facing="right" />
        <Icon name="sx3mf" className="rv-carry-file" style={{ width: 10, height: 10 }} />
      </span>
    </span>
  )
}
