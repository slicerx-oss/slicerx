// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bar over the plate while a STEP file is read: its name and Cancel. It comes only once a read has run past
// about 1.2 s, as the ravens do, so a quick read never blinks it. Cancel ends the reader, and the open says so.
import { Button } from '@slicerx/ui'
import { useSyncExternalStore } from 'react'
import { useWaited } from '../lib/waited'
import { cancelStepRead, onStepReading, stepReading } from '../state/step-reading'

export function StepReadingBar() {
  const reading = useSyncExternalStore(onStepReading, stepReading, () => null)
  const long = useWaited(reading !== null)
  if (!reading || !long) return null
  return (
    <div className="step-reading sx-overlay" role="status" data-testid="step-reading">
      <span className="step-reading-name">Reading {reading.name}</span>
      <Button size="sm" onClick={cancelStepRead} data-testid="step-reading-cancel">
        Cancel
      </Button>
    </div>
  )
}
