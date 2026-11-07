// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer tops a resume plans with: the failed job's own layers. The app has them while its slice is current or
// once a plan stored them; otherwise (a reopened project, a resume from the printer list) the engine works them out
// from the plate as the job sliced it, so the plan never counts in layers of its own making.
import type { Host } from '@slicerx/contracts'
import { get, type AppState } from '../state/store'

/**
 * The failed job's layers: a resume plan's stored tops, else the last slice's layers while it is still current. A
 * stale slice (the plate or its settings changed since) is not the plate a resume slices, so it gives none.
 */
export function jobLayerTops(s: Pick<AppState, 'resume' | 'slice'>): number[] | undefined {
  if (s.resume?.layerTopsMm?.length) return s.resume.layerTopsMm
  if (s.slice.status !== 'done' || s.slice.stale) return undefined
  const z = (s.slice.result as { layerZ?: ArrayLike<number> }).layerZ
  return z && z.length ? Array.from(z) : undefined
}

/** The layers a resume of the shown plate plans with, and the plate they are for. */
export interface ResumeLayers {
  plate: string
  tops: number[]
}

/**
 * The job's layers for the shown plate: jobLayerTops when the app has them, else the engine's (plateLayerZ). Null when
 * `signal` aborts or the shown plate changes before they are ready, so a closed dialog or another plate never gets
 * them. Engine errors reach the caller.
 */
export async function resumeLayers(host: Host, signal: AbortSignal): Promise<ResumeLayers | null> {
  const plate = get().activePlate
  const job = jobLayerTops(get())
  if (job) return { plate, tops: job }
  const { plateLayerZ } = await import('../state/slice-plate')
  try {
    const tops = await plateLayerZ(host, signal)
    return signal.aborted || get().activePlate !== plate ? null : { plate, tops }
  } catch (e) {
    if (signal.aborted || get().activePlate !== plate) return null
    throw e
  }
}
