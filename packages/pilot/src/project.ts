// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The view of the open project that skills work on. The app implements it over
// its store; the evals implement it in memory.
import type { MeshPart, PilotMachine, Plate, PrintConfig, SettingValue, SliceWarning, VolumeRole } from '@slicerx/contracts'

export interface ProjectObject {
  id: string
  name: string
  /** Axis-aligned size in mm, Z up, as placed. */
  bboxMm: [number, number, number]
  triangles?: number
  /** Where it sits, as its transform places it: `gridMm` from the grid center (the frame Model shows), `bedMm` from the bed's front left corner (the frame Slice shows). */
  positionMm?: { gridMm: [number, number, number]; bedMm: [number, number, number] }
  /** Metadata from the file (title, designer, comments). Untrusted text. */
  metadata?: Record<string, string>
  /** Geometry for skills that need it (orient, cut). */
  mesh?(): Promise<MeshPart[]>
}

export interface ProjectPlate {
  index: number
  /** Printer id the plate is assigned to. */
  printerId?: string
  items: {
    objectId: string
    copies: number
    /** Label for the rotation, such as "on its back". */
    rotation?: string
    /** Degrees about X, then Y, then Z, applied before placing on the bed. */
    rotate?: [number, number, number]
  }[]
  /** Per-plate overrides by Orca key. */
  overrides?: Record<string, SettingValue>
}

/** A simple shape for a volume, sized in mm. A cylinder stands along Z. */
export type VolumeShape = { kind: 'box'; sizeMm: [number, number, number] } | { kind: 'cylinder'; diameterMm: number; heightMm: number } | { kind: 'sphere'; diameterMm: number }

/** A volume to add to an object: placed by its center in the object's own coordinates (as modeled), mm. */
export interface VolumeSpec {
  role: VolumeRole
  name: string
  shape: VolumeShape
  centerMm: [number, number, number]
  /** For a modifier: the settings inside it, Orca keys. */
  settings?: Record<string, SettingValue>
}

/** A volume as the project holds it, for read-back. */
export interface ProjectVolume {
  id: string
  name: string
  role: VolumeRole
  settings?: Record<string, SettingValue>
}

export interface PilotProject {
  name: string
  machine(): PilotMachine | undefined
  objects(): ProjectObject[]
  plates(): ProjectPlate[]
  /** Replace the plate layout (class slice: stays inside the project). May say what found no room on the bed. */
  setPlates(plates: ProjectPlate[]): void | PlatesLeftOff
  /** Capacity of the host's actual layout, including the resolved first-layer margins. */
  arrangeCapacity?(objectId: string, bed: { x: number; y: number; round?: boolean }, spacing: number, plateIndex: number): number
  /** Project level overrides by Orca key. */
  overrides(): Record<string, SettingValue>
  setOverrides(changes: Record<string, SettingValue>): void
  /** The resolved config for a plate, profile plus overrides. */
  config(plateIndex: number): PrintConfig
  /** The geometry request for a plate, ready for `SlicerHost.slice`. */
  plate(plateIndex: number): Promise<Plate>
  /** Replace objects with others (cut parts). Class slice, and approved when policy asks. */
  replaceObjects?(ids: string[], replacements: ProjectObject[]): void | Promise<void>
  /** Add a generated or found object, with its geometry, on a new plate. */
  addObject?(obj: ProjectObject, parts: MeshPart[]): Promise<void>
  /** Set the rotation of an object on every plate it is on. */
  setRotation?(objectId: string, rotate: [number, number, number], label?: string): void
  /**
   * The engine's warnings for a plate as it is now (thin walls, floating islands, long bridges), when the
   * host already sliced it; null when it has no current slice.
   */
  warnings?(plateIndex: number): Promise<SliceWarning[] | null>
  /** Add a volume (a cut, a support region or a settings modifier) to an object and its copies. Class slice. */
  addVolume?(objectId: string, volume: VolumeSpec): Promise<{ id: string }>
  /** An object's volumes, for read-back. */
  volumes?(objectId: string): ProjectVolume[]
  /** Set an object's own settings over the project's (Orca keys). Class slice. */
  setObjectSettings?(objectId: string, changes: Record<string, SettingValue>): void
  /** An object's own settings, for read-back. */
  objectSettings?(objectId: string): Record<string, SettingValue>
}

/** What a new plate layout could not fit: parts still off the bed, and copies that found no room and were not added. */
export interface PlatesLeftOff {
  leftOff: number
  notAdded?: number
}

/** Plain sentences for what a layout could not fit, or '' when everything fit. */
export function leftOffWords(r: void | PlatesLeftOff | undefined): string {
  const off = r?.leftOff ?? 0
  const notAdded = r?.notAdded ?? 0
  const out: string[] = []
  if (off > 0) out.push(off === 1 ? '1 part is still off the bed because there is no room for it.' : `${off} parts are still off the bed because there is no room for them.`)
  if (notAdded > 0) out.push(notAdded === 1 ? '1 copy did not fit, so it was not added.' : `${notAdded} copies did not fit, so they were not added.`)
  return out.join(' ')
}
