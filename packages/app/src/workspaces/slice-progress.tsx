// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A thin glowing bar along the top of the viewport while the plate slices, filled from the engine's own progress
// (the same fraction as the sidebar's Estimate bar). It shows only for a slice that takes longer than 250 ms, stays at least 400 ms once
// it shows, then fills and fades out, so quick re-slices after an edit never blink. Model loading still sweeps, with
// the ravens before the model's first frame and the 3D view's wisp after it.
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useWaited } from '../lib/waited'
import type { SliceProgress as SliceProgressValue } from '@slicerx/contracts'
import { useApp } from '../state/store'
import { useLoading } from '../ravens/use-loading'

// The ravens load only once a wait has run past about 1.2 s.
const LoadingRavens = lazy(() => import('../ravens/waits').then((m) => ({ default: m.LoadingRavens })))

/** How long the ravens over a loading plate take to fly off once the model is on it. */
const LEAVE_MS = 420

const SHOW_AFTER_MS = 250
const MIN_SHOWN_MS = 400

export function SliceProgress() {
  const slice = useApp((s) => s.slice)
  const loading = useApp((s) => s.plateLoading)
  const running = slice.status === 'running'
  // The same value the sidebar's Estimate bar shows: the hosts report one fraction for the whole slice.
  const fraction = running ? sliceFraction(slice.progress) : 0
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
  const p = done ? 1 : fraction
  return (
    <>
      {loading ? (
        <div className="busy" aria-hidden="true"><i /></div>
      ) : shown ? (
        <div className="slice-progress" data-done={done || undefined} role="progressbar" aria-label="Slicing" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
          <i style={{ '--p': p } as CSSProperties} />
        </div>
      ) : null}
      <LoadingWait />
    </>
  )
}

/** How far a running slice is, 0 to 1, as every progress bar shows it. */
export function sliceFraction(progress: SliceProgressValue | null | undefined): number {
  return progress ? Math.min(1, Math.max(0, progress.fraction)) : 0
}

/**
 * Huginn and Muninn over the plate while a model takes more than about 1.2 s to reach its first frame; they fly off
 * once it is drawn, and the 3D view's wisp runs the plate edge for the rest of the wait (ravens/loading-phase.ts).
 */
function LoadingWait() {
  const { phase } = useLoading()
  const [state, setState] = useState<'off' | 'in' | 'leaving'>('off')
  useEffect(() => {
    if (phase === 'ravens') return setState('in')
    setState((st) => (st === 'in' ? 'leaving' : st))
    const t = window.setTimeout(() => setState('off'), LEAVE_MS)
    return () => window.clearTimeout(t)
  }, [phase])
  if (state === 'off') return null
  return <Suspense fallback={null}><LoadingRavens leaving={state === 'leaving'} /></Suspense>
}
