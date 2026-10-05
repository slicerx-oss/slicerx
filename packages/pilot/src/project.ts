// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The view of the open project that skills work on. The app implements it over
// its store; the evals implement it in memory.
import type { MeshPart, PilotMachine, Plate, PrintConfig, SettingValue, SliceWarning } from '@slicerx/contracts'

export interface ProjectObject {
  id: string
  name: string
  /** Axis-aligned size in mm, Z up, as placed. */
  bboxMm: [number, number, number]
  triangles?: number
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

export interface PilotProject {
  name: string
  machine(): PilotMachine | undefined
  objects(): ProjectObject[]
  plates(): ProjectPlate[]
  /** Replace the plate layout (class slice: stays inside the project). */
  setPlates(plates: ProjectPlate[]): void
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
}
