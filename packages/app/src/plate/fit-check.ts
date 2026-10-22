// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the fit check (fit-run.ts) whenever the plate changes, and keeps the results in fit-state. The check's code
// loads the first time a plate needs it, not at startup. It runs whatever is on screen: auto slice holds a big slice
// for it (auto-slice.ts), and the shut right pane's tab glows for its notes, so it is not tied to the objects list.
import { useEffect } from 'react'
import { clearanceFor } from './clearance'
import { resolveConfig } from '../adapters/settings'
import { get, toast, useApp } from '../state/store'
import { fitSettled, keepFits, setFit, setTouches } from './fit-state'

/** The smallest side-by-side gap the printer keeps open, per side: the fit clearance (`clearance.ts`). */
export function minGapFor(s: ReturnType<typeof get>): number {
  return clearanceFor(s).mm
}

/** The message of the last fit check failure toasted, so a plate that fails on every edit says so once. */
let toasted: string | null = null
/** Whether a check has run, so its worker may hold meshes. */
let ran = false

/** One toast for a check that failed (never for one canceled); a check that runs clean again resets it. */
function fitFailed(e: unknown): void {
  if (e === null) {
    toasted = null
    return
  }
  const message = e instanceof Error ? e.message : String(e)
  if (message === toasted) return
  toasted = message
  toast(`The fit check failed, so gaps between parts are not shown. ${message}`, 'warn')
}

/** Checks the plate as it changes, a moment after the last edit. Mounted once, by FitWatch. */
export function useFitWatch(): void {
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const presets = useApp((s) => s.userPresets)
  useEffect(() => {
    keepFits(plate.map((p) => p.id))
    const printed = plate.filter((p) => p.printable !== false && p.parts.length > 0)
    const multi = printed.filter((p) => p.parts.length > 1)
    for (const p of plate) if (p.parts.length < 2 || p.printable === false) setFit(p.id, null)
    if (printed.length < 2) setTouches([])
    if (multi.length === 0 && printed.length < 2) {
      // the check's worker lets go of the meshes it kept, once there is one
      if (ran) void import('./fit-run').then((m) => m.keepPlateMeshes([]))
      fitSettled(plate)
      return
    }
    ran = true
    const ac = new AbortController()
    const t = setTimeout(() => {
      const s = get()
      const minGapMm = minGapFor(s)
      const layerHeightMm = Number(resolveConfig(easy, overrides)['layer_height']) || 0.2
      let failure: unknown = null
      const failed = (e: unknown) => {
        if (!ac.signal.aborted) failure ??= e
      }
      void import('./fit-run')
        .then(async ({ checkObject, checkTouches, keepPlateMeshes }) => {
          if (ac.signal.aborted) return
          keepPlateMeshes(printed)
          const runs: Promise<unknown>[] = multi.map((e) =>
            checkObject(e, minGapMm, layerHeightMm, ac.signal).catch((err: unknown) => {
              failed(err)
              if (!ac.signal.aborted) setFit(e.id, null)
            }),
          )
          if (printed.length > 1)
            runs.push(
              checkTouches(printed, minGapMm, layerHeightMm, ac.signal)
                .then((found) => !ac.signal.aborted && setTouches(found))
                .catch((err: unknown) => {
                  failed(err)
                  if (!ac.signal.aborted) setTouches([])
                }),
            )
          await Promise.all(runs)
        })
        .catch(failed)
        .then(() => {
          if (ac.signal.aborted) return
          fitFailed(failure)
          fitSettled(plate)
        })
    }, 600)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [plate, easy, overrides, presets])
}

/**
 * The one fit watch, mounted with the app shell. In the objects list it ran only while the list was drawn: with Slice's
 * right pane shut no fit check ran, and every big auto slice waited the full FIT_WAIT_MS.
 */
export function FitWatch(): null {
  useFitWatch()
  return null
}
