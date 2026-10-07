// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A thin glowing bar along the top of the viewport while the plate slices, filled from the engine's own progress
// (its stage and how far into it). It shows only for a slice that takes longer than 250 ms, stays at least 400 ms once
// it shows, then fills and fades out, so quick re-slices after an edit never blink. Model loading still sweeps.
import { SLICE_STAGES } from '@slicerx/contracts'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useApp } from '../state/store'

const SHOW_AFTER_MS = 250
const MIN_SHOWN_MS = 400

export function SliceProgress() {
  const slice = useApp((s) => s.slice)
  const loading = useApp((s) => s.plateLoading)
  const running = slice.status === 'running'
  const fraction = running && slice.progress ? (SLICE_STAGES.indexOf(slice.progress.stage) + Math.min(1, Math.max(0, slice.progress.fraction))) / SLICE_STAGES.length : 0
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(false)
  const since = useRef(0)
  useEffect(() => {
    if (running) {
      setDone(false)
      const t = setTimeout(() => {
        since.current = performance.now()
        setShown(true)
      }, SHOW_AFTER_MS)
      return () => clearTimeout(t)
    }
    if (!shown) return
    // Finish the fill, hold it briefly, then fade.
    setDone(true)
    const t = setTimeout(() => setShown(false), Math.max(180, MIN_SHOWN_MS - (performance.now() - since.current)))
    return () => clearTimeout(t)
  }, [running, shown])
  if (loading) return <div className="busy" aria-hidden="true"><i /></div>
  if (!shown) return null
  return (
    <div className="slice-progress" data-done={done || undefined} role="progressbar" aria-label="Slicing" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((done ? 1 : fraction) * 100)}>
      <i style={{ '--p': done ? 1 : fraction } as CSSProperties} />
    </div>
  )
}
