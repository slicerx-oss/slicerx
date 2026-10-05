// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print the rest from this height: after a failed print with the part still on the bed, find the
// layer to restart at (sx-geom resume, the same layer plan as the engine) and the slice options that
// write G-code from that layer only. The plate is sliced whole as before, so walls and infill line
// up with what is already printed.
//
//   const plan = await planResume(plate, { measuredHeightMm: 31.4, layerHeightMm: 0.2, firstLayerHeightMm: 0.2 })
//   slice({ ...request, options: { ...request.options, ...resumeSliceOptions(plan) } })
import { geom, type GeomMesh } from './client'
import type { Mat4, MeshItem } from './cad'

export interface ResumeInput {
  /** Height of the part left on the bed, measured from the bed. */
  measuredHeightMm?: number
  /** Layer the printer showed when it stopped, counting from 1. That layer is printed again. */
  failedLayer?: number
  firstLayerHeightMm: number
  layerHeightMm: number
  /** The failed job's layer tops when it varied layer height (the slice request's layerTopsMm). */
  layerTopsMm?: number[]
  /** How far a measurement may sit above a layer top and still count it as done. Default: half a layer. */
  toleranceMm?: number
  /** Return the part still to print, for the preview. */
  includeRemainingMesh?: boolean
}

export interface ResumePlan {
  /** First layer to print, counting from 0 (the slice option). */
  resumeLayer: number
  /** The same layer counting from 1, as printers show it. */
  resumeLayerNumber: number
  layerCount: number
  remainingLayers: number
  /** Top of the last layer already on the bed. */
  printedHeightMm: number
  /** Nozzle height for the first resumed layer. */
  resumeZMm: number
  warnings: string[]
  /** The model above printedHeightMm, in place, in world coordinates. */
  remaining?: GeomMesh
}

/** Every printable object on the plate, as it was printed (mesh and plate transform). */
export type PlateObjects = { mesh: GeomMesh; transform: Mat4 }[] | MeshItem

/** Where to restart. Give the measured height, the printer's layer number, or both. */
export function planResume(plate: PlateObjects, input: ResumeInput, signal?: AbortSignal): Promise<ResumePlan> {
  if (input.measuredHeightMm === undefined && input.failedLayer === undefined) {
    return Promise.reject(new Error('Enter the height of the part on the bed or the layer the print stopped on'))
  }
  const where = Array.isArray(plate) ? { meshes: plate } : { mesh: plate }
  return geom().call<ResumePlan>('resume', { ...where, includeRemainingMesh: false, ...input }, signal)
}

/**
 * Slice options for the rest of the print. With declareZ the G-code sets the nozzle height (G92 Z)
 * to the top of the printed part; the person moves the nozzle to touch it first, and the slice
 * result carries a manual_step warning saying so. Without it the printer keeps the Z it has.
 */
export function resumeSliceOptions(plan: Pick<ResumePlan, 'resumeLayer' | 'printedHeightMm'>, declareZ = false): { resumeFromLayer: number; resumeZ?: { mode: 'declare'; zMm: number } } {
  if (plan.resumeLayer <= 0) return { resumeFromLayer: 0 }
  return declareZ ? { resumeFromLayer: plan.resumeLayer, resumeZ: { mode: 'declare', zMm: plan.printedHeightMm } } : { resumeFromLayer: plan.resumeLayer }
}
