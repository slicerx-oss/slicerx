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

/** A read of the project's print settings (settings.get on the app link), by setting key. */
export interface PrintSettingsRead {
  /** The shown plate's id. */
  plate: string
  /** The project's own overrides among the keys read. */
  overrides: Record<string, SettingValue>
  /** What the shown plate slices with: the profile, the Easy choices, the plate's choices and the overrides. */
  effective: Record<string, SettingValue>
  /** Overrides the plate's own choices replace. */
  shadowed: string[]
}

export interface PilotProject {
  name: string
  machine(): PilotMachine | undefined
  objects(): ProjectObject[]
  plates(): ProjectPlate[]
  /** Replace the plate layout (class slice: stays inside the project). May say what found no room on the bed. */
  setPlates(plates: ProjectPlate[]): void | PlatesLeftOff
  /** Capacity of the host's actual layout, including the resolved first-layer margins. */
  arrangeCapacity?(objectId: string, bed: { x: number; y: number; round?: boolean }, spacing: number, plateIndex: number): number | Promise<number>
  /** Lays the plates `setPlates` gave out on true outlines (a host with a geometry engine), `spacing` mm apart. May say what found no room. */
  arrangePlates?(plateIndexes: readonly number[], spacing: number): Promise<PlatesLeftOff | undefined>
  /**
   * Arranges one object's copies, `copies` on each plate named, around the other objects there, which stay where they
   * are; copies with no room around them go to new plates after the last. Every other object keeps its plate. The
   * object leaves the plates not named. Says which copies moved to which plate, and what found no room on any bed.
   */
  arrangeObject?(objectId: string, plates: readonly ObjectPlan[], spacing: number): Promise<ArrangedObject>
  /** Project level overrides by Orca key. */
  overrides(): Record<string, SettingValue>
  setOverrides(changes: Record<string, SettingValue>): void
  /** The resolved config for a plate, profile plus overrides. */
  config(plateIndex: number): PrintConfig
  /**
   * The print settings the shown plate slices with, as the app link's settings.get reads them: the project overrides
   * and the effective values by setting key, narrowed to `keys`. Throws for a key that is not a readable print setting.
   */
  printSettings?(keys: readonly string[]): PrintSettingsRead | Promise<PrintSettingsRead>
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
  /**
   * heimdall's plate check of a plate printed by object as it sits, before a slice: null by layer, with fewer than two
   * objects, or on a host without the check. `leftSure` lists the pairs a slice is sure to be refused for, by object id
   * and name; the rest (the collisions with their certainty, the fixes, what only the slice checks) is the host's.
   */
  plateCheck?(plateIndex: number): Promise<PlateCheckSummary | null>
}

/** What arrange and other tools read of a plate check: the pairs left with a sure strike, and the rest as the host gives it. */
export interface PlateCheckSummary {
  clean: boolean
  leftSure: { a: { id: string; name: string }; b: { id: string; name: string }; collisions: number[] }[]
  fixes: readonly unknown[]
  [more: string]: unknown
}

/** What a new plate layout could not fit: parts still off the bed, and copies that found no room and were not added. */
export interface PlatesLeftOff {
  leftOff: number
  notAdded?: number
}

/** How many copies of an object go on a plate (arrangeObject), and the printer the plate goes to. */
export interface ObjectPlan {
  index: number
  copies: number
  printerId?: string
}

/** Copies that had no room on their plate and went to another one. */
export interface MovedCopies {
  objectId: string
  copies: number
  from: number
  to: number
}

/** One copy an arrange placed: its plate object id (`obj-1-3`), its plate, and how far it turned about Z. */
export interface CopyTurn {
  id: string
  plate: number
  /** Degrees about Z after the object's rotation, from 0 up to 360; 0 when it is not turned. */
  turnDeg: number
}

/** What arrangeObject did: the copies it moved to other plates, and what found no room on any bed. */
export interface ArrangedObject extends PlatesLeftOff {
  moved: MovedCopies[]
  /** Every copy of the object where the arrange left it, with its turn. */
  turns?: CopyTurn[]
}

/** One sentence per move: `2 copies of obj-1 moved to plate 3.` */
export function movedWords(moved: readonly MovedCopies[]): string {
  return moved.map((m) => `${m.copies === 1 ? '1 copy' : `${m.copies} copies`} of ${m.objectId} had no room on plate ${m.from}, so ${m.copies === 1 ? 'it' : 'they'} moved to plate ${m.to}.`).join(' ')
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
