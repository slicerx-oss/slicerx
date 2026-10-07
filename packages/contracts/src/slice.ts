// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice requests and results. Mirrors sx-core's public types.
import type { PrintConfig, SettingValue } from './settings'

export type EngineId = 'sx' | 'orca'
export type GcodeFlavor =
  | 'marlin2'
  | 'klipper'
  | 'reprapfirmware'
  | 'bambu'
  | 'marlin'
  | 'reprap'
  | 'repetier'
  | 'teacup'
  | 'makerware'
  | 'sailfish'
  | 'mach3'
  | 'machinekit'
  | 'smoothie'
  | 'no-extrusion'
  /** Ultimaker S3, S5 and S7. */
  | 'griffin'
  /** Ultimaker S6 and S8. */
  | 'cheetah'

/** Pipeline stages, in order. Settings declare the first stage they invalidate. */
export const SLICE_STAGES = ['layers', 'contours', 'perimeters', 'surfaces', 'infill', 'paths', 'gcode', 'preview'] as const
export type SliceStage = (typeof SLICE_STAGES)[number]

/** A loaded model, referenced by content hash so re-slicing never copies geometry again. */
export interface MeshHandle {
  id: string
  hash: string
  name: string
  triangles: number
  /** Axis-aligned size in mm, Z up. */
  bboxMm: [number, number, number]
  openEdges: number
  parts: MeshPartInfo[]
}

export interface MeshPartInfo {
  name: string
  /** Filament slot, 1-based as in Orca's `extruder`. */
  slot: number
  color?: string
  triangles: number
}

/** The settings entries of a Bambu Studio or Orca 3MF project, in the request shape of the settings crate's project import. */
export interface ProjectMetadata {
  /** Metadata/project_settings.config, parsed. */
  projectSettings?: Record<string, unknown>
  /** Text of Metadata/model_settings.config. */
  modelSettings?: string
  /** Text of Metadata/layer_config_ranges.xml. */
  layerRanges?: string
}

/** The surface a face of a part lies on (sx-geom `faces.rs`). Plane normals point out of the part. */
export type FaceSurface =
  | { kind: 'plane'; normal: [number, number, number]; offset: number }
  | { kind: 'cylinder'; origin: [number, number, number]; axis: [number, number, number]; radius: number }
  | { kind: 'cone'; apex: [number, number, number]; axis: [number, number, number]; halfAngle: number }
  | { kind: 'sphere'; center: [number, number, number]; radius: number }
  | { kind: 'other' }

/** Which face each triangle belongs to, and the surface of each face. */
export interface MeshFaces {
  /** One per triangle, an index into `table`. */
  ids: Uint32Array
  table: FaceSurface[]
  /** A key per face in `table` that history steps name the face by; absent when the engine gave none. */
  keys?: number[]
}

/** Raw geometry for hosts that take buffers directly (tests, the benchmark, Pilot's cut skill). */
export interface MeshPart {
  name: string
  slot: number
  positions: Float32Array
  indices: Uint32Array
  /** The part's faces, when the geometry engine knows them. Code that changes the triangles leaves them out. */
  faces?: MeshFaces
}

export interface Bed {
  widthMm: number
  depthMm: number
  heightMm: number
}

/** What an extra volume of an object does: cut material away, keep support out, force it in, or print the object inside it with other settings. */
export type VolumeRole = 'negative' | 'support_blocker' | 'support_enforcer' | 'modifier'

export interface PlateVolume {
  name?: string
  role: VolumeRole
  mesh: MeshHandle['id']
  /** Defaults to the object's transform, so the volume keeps its place in the object. */
  transform?: number[]
  /** For a modifier: Orca key overrides that apply to the object inside the volume (walls, infill, speeds, flow). */
  settings?: Record<string, SettingValue>
}

export interface PlateObject {
  id: string
  name: string
  mesh: MeshHandle['id']
  /** 4x4 column-major transform, mm, Z up, origin at the bed's front left corner. */
  transform: number[]
  /** Part name to filament slot, when the plate differs from the file. */
  slotOverrides?: Record<string, number>
  /** Orca key overrides for this object. Objects may differ: each slices with its own walls, infill, shells, supports and speeds (temperatures, fans and retraction follow the plate). Layer height may differ only when the plate prints by object. */
  settings?: Partial<PrintConfig> & Record<string, SettingValue>
  /** Negative volumes, support blockers and support enforcers. */
  volumes?: PlateVolume[]
  /** Orca key overrides for single parts of the mesh, by part name: the part's own area prints with them (walls, infill, shells, line widths, speeds), as a modifier shaped like the part would. */
  partSettings?: Record<string, Record<string, SettingValue>>
  /** Painted brim ears for `brim_type` painted: [x, y, z, headRadius] in mm, in the mesh's own space (before `transform`), z at or under the bed after the transform. */
  brimPoints?: [number, number, number, number][]
}

export interface Plate {
  bed: Bed
  objects: PlateObject[]
}

/** Setting overrides for a band of heights. Only wall count, temperature, flow, pressure advance, speeds and retraction may change by height; geometry keys are rejected. */
export interface HeightRange {
  zFromMm: number
  /** Must be greater than zFromMm. */
  zToMm: number
  /** Orca keys, such as `nozzle_temperature` or `pressure_advance`. */
  settings: Record<string, SettingValue>
  /**
   * Ids of the plate objects the range applies to (`PlateObject.id`); absent for every object. Objects printed
   * one after another (`print_sequence` by object) each get their own temperature, pressure advance and
   * retraction. Objects printed layer by layer share the nozzle, so those keys then apply to the whole layer.
   */
  objects?: string[]
}

export type LayerGcode = ({ layer: number; zMm?: never } | { zMm: number; layer?: never }) & { kind: 'pause' | 'color_change' | 'custom'; gcode?: string }

export interface SliceOptions {
  engine?: EngineId
  flavor?: GcodeFlavor
  /** Web host only: number of worker shards. Output is identical for any value. */
  shards?: number
  emitGcode?: boolean
  emitPreview?: boolean
  /** The time of this slice, seconds since 1970 UTC, for the G-code date and time variables some printers' G-code uses. The browser and desktop hosts fill it on every slice. */
  nowUnix?: number
  /** The local offset from UTC in minutes (east is positive) that goes with `nowUnix`. */
  nowOffsetMinutes?: number
  /**
   * sleipnir: the top of every layer in mm, first entry is the first layer's top. Entries strictly
   * ascend, each layer is 0.04 to 0.8 mm thick, and the last reaches the top of the plate. Replaces
   * layer_height and initial_layer_print_height.
   */
  layerTopsMm?: number[]
  /**
   * Resume a print at this layer (0-based). The plate is sliced whole and G-code is written only from
   * this layer, after a start sequence that heats, homes X and Y but not Z, and draws no purge line.
   * The preview still holds every layer. 0 means a normal print; past the last layer is an error.
   * `@slicerx/geom` `resume` turns a measured height into this layer index and the Z it starts at.
   */
  resumeFromLayer?: number
  /**
   * With resumeFromLayer: declare the nozzle's Z (G92 Z after homing X and Y) instead of leaving it as the
   * printer has it. The result carries a manual_step warning: the nozzle must be at zMm by hand first.
   * mimir asks the person before using it.
   */
  resumeZ?: { mode: 'declare'; zMm: number }
  /** Setting overrides by height (calibration towers, temperature and pressure advance tests). */
  heightRanges?: HeightRange[]
  /**
   * G-code written at the start of layers: a pause, a color change, or custom text such as a firmware setting for a
   * calibration band. Each entry gives `layer` (0-based) or `zMm`: the first layer whose top reaches that height, on
   * the layers the engine plans. Of several entries by height that land on one layer, the last stays.
   */
  layerGcode?: LayerGcode[]
  /** Limits of the target printer in C. Settings above them are lowered and reported as safety_limit warnings. */
  machineLimits?: { nozzleMaxC?: number; bedMaxC?: number; chamberMaxC?: number; ptfeLined?: boolean }
  /** The custom G-code in the config is the person's own. Off by default: imported text gets the strict linter. */
  trustedGcode?: boolean
  /** For the `filename_format` placeholders `{plate_name}`, `{plate_number}` (from 1) and `{model_name}` (the project's name). */
  plateName?: string
  plateNumber?: number
  modelName?: string
  /** Image for the G-code thumbnails: raw RGBA bytes, width by height pixels. The engine scales it to the sizes the profile asks for. */
  thumbnail?: { width: number; height: number; rgba: Uint8Array }
  /** The printer profile id (`bambu-h2d`): heimdall checks the plate with that printer's head, gantry and tool changer. */
  printerId?: string
}

export interface SliceRequest {
  plate: Plate
  config: PrintConfig
  options?: SliceOptions
}

export interface SliceProgress {
  stage: SliceStage
  /** 0 to 1 within the stage. */
  fraction: number
}

export interface SliceStats {
  /** The print's time as the finished file reads it: the start before the first layer, every layer, the end. */
  timeS: number
  /** Seconds of `timeS` before the first layer (heating, homing, leveling, the purge line); `layerTimeS` adds up to the rest. */
  prepareS?: number
  /** Per filament slot, index 0 is slot 1. */
  filamentMm: number[]
  filamentG: number[]
  cost: number
  toolChanges: number
}

export type SliceWarningCode = 'open_edges' | 'thin_wall' | 'floating_region' | 'long_bridge' | 'outside_bed' | 'unsupported_setting' | 'manual_step' | 'collision' | 'safety_limit'

export interface SliceWarning {
  code: SliceWarningCode
  message: string
  objectId?: string
  layer?: number
}

/** Why the prime tower stands where it does. */
export type PrimeTowerReason =
  /** Where `wipe_tower_x` and `wipe_tower_y` put it. */
  | 'kept'
  /** Picked by the engine (`prime_tower_auto_position`): clear of the objects and no-go zones, shortest travel, toward the back. */
  | 'auto'
  /** Pulled back onto the bed by the least distance. */
  | 'moved_onto_bed'
  /** Moved to the nearest spot clear of the objects and the printer's no-go zones. */
  | 'moved_clear'
  /** Made wider and shallower, or turned a quarter, to fit at all. */
  | 'reshaped'

/** The prime tower as the engine placed it: front left corner, size and rotation about that corner. mm and degrees. */
export interface PrimeTowerPlacement {
  x: number
  y: number
  width: number
  depth: number
  angle: number
  reason: PrimeTowerReason
}

/**
 * Which nozzle prints each filament on a printer with two extruders fed by their own AMS (Bambu Lab H2D and H2C):
 * Bambu Studio's `filament_maps`.
 */
export interface FilamentMapInfo {
  /** The extruder of each filament (index slot - 1): 1 the left, 2 the right. */
  extruders: number[]
  /** The nozzle of each filament: 0 the left extruder's, the right extruder's from 1 (one per H2C rack hotend). */
  nozzles: number[]
  /** True when the slicer picked the map, false when the plate's settings gave it. */
  auto: boolean
}

/** What variable layer heights (sleipnir) cost on a multi-color plate against fixed layers. */
export interface VaryLayerCost {
  /** Tool changes added (negative when fewer). */
  extraToolChanges: number
  /** Filament purged on the tower and into the chute, grams added. */
  extraPurgeG: number
}

/** What of the machine meets a printed part. */
/**
 * What of the machine meets a printed part; or `path_conflict`, the paths of two objects (or of an object and the prime
 * tower, `prime-tower`) crossing on one layer; or `keep_out`, a print path in a zone the printer keeps clear
 * (`exclusion-area`, `wrap-check-zone`).
 */
export type CollisionKind = 'gantry' | 'hotend' | 'nozzle_travel_through_part' | 'tool_change' | 'dock' | 'path_conflict' | 'keep_out'

/**
 * One place where the machine would meet a part already printed (heimdall, print by object). `hit` is the head's own
 * shape; `close` is only inside the printer profile's clearance radius, with the head itself clearing. Codes, numbers
 * and object ids: the app writes the words.
 */
export interface Collision {
  kind: CollisionKind
  severity: 'hit' | 'close'
  /** The piece of the machine: the nozzle, the toolhead, the gantry beam or the frame over the bed (the profile's lid height). */
  part: 'nozzle' | 'toolhead' | 'gantry' | 'lid'
  /** The plate object printing, and the one it meets. */
  objectId: string
  hitId: string
  /** When it first happens: plate layer (0-based), the layer's extrusion segment as the preview counts them, print time. */
  layer: number
  segment: number
  timeS: number
  lastLayer: number
  /** The nozzle tip, and where the machine meets the part, at that moment, mm. */
  at: [number, number, number]
  point: [number, number, number]
  /** The layer and the spot where it goes deepest. */
  worstLayer: number
  worstPoint: [number, number, number]
  depthMm: number
  /** How tall the object it meets stands, mm. */
  hitHeightMm: number
  /** The clearance it breaks, mm: the rod height (gantry), the lid height (lid), the clearance radius (close call). */
  limitMm?: number
  /** The extra spacing that clears a toolhead strike sideways, mm. */
  pushMm?: number
  /** During a tool change: the tools (0-based) and how far along the trip, 0 to 1. */
  change?: [number, number, number]
}

export type CollisionFixKind = 'reorder' | 'by_layer' | 'spread' | 'raise_lift' | 'move_object' | 'arrange'

/** A way to clear some of the collisions, with the print time it adds. */
export interface CollisionFix {
  kind: CollisionFixKind
  costS: number
  /** Indices into the collisions it clears. */
  clears: number[]
  /** Safe to apply with one click (a new order, print by layer, arrange the plate); the others are explained. */
  oneClick: boolean
  /** reorder: the plate object ids in the new print order. */
  order?: string[]
  /** spread: the extra space between objects; raise_lift: the Z hop, mm. */
  mm?: number
  /** move_object: which object. */
  objectId?: string
  /** by_layer: the most extra travel moves on one layer. */
  moves?: number
  /** Reorder: the close calls the new order still has (inside the profile's radius; the head itself clears them). */
  closeCalls?: number
}

export interface SliceResult {
  id: string
  engine: EngineId
  layerCount: number
  layerZ: Float32Array
  layerTimeS: Float32Array
  stats: SliceStats
  /** Microseconds spent per stage, summed over shards. */
  stageMicros: Partial<Record<SliceStage, number>>
  /** Wall time from request to result, ms. */
  wallMs: number
  warnings: SliceWarning[]
  /** `bgcode` when the profile asked for binary G-code (Prusa); absent for plain text. */
  gcodeFormat?: 'bgcode'
  /** The name the profile's `filename_format` gives the G-code file; absent when the host did not return one. */
  fileName?: string
  /** Where the prime tower stands; absent when the plate has none. */
  primeTower?: PrimeTowerPlacement
  /** Present when the plate has two or more filaments and variable layer heights. */
  varyLayerCost?: VaryLayerCost
  /** Present on a printer with two extruders fed by their own AMS: the nozzle of each filament. */
  filamentMap?: FilamentMapInfo
  /** Print by object: every place the head, gantry or tool changer would meet a printed part, in print order. */
  collisions?: Collision[]
  /** Fixes for the collisions. */
  collisionFixes?: CollisionFix[]
}

export type GcodeTarget = { kind: 'blob' } | { kind: 'path'; path: string }

export interface GcodeExport {
  fileName: string
  bytes: number
  sha256: string
  /** Present when target.kind is 'blob'. */
  blob?: Blob
  path?: string
}

export interface SlicerHost {
  loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle>
  loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle>
  slice(req: SliceRequest, opts?: { onProgress?: (p: SliceProgress) => void; signal?: AbortSignal }): Promise<SliceResult>
  /**
   * Geometry of a loaded model (3MF, STL or parts) for drawing, in the file's build space, before the
   * plate transform. Optional: hosts that only slice may not have it.
   */
  meshParts?(meshId: MeshHandle['id']): Promise<MeshPart[]>
  /** Settings entries of a 3MF project, without loading its geometry. Optional. */
  projectMetadata?(data: ArrayBuffer, fileName: string): Promise<ProjectMetadata>
  /** SXPV bytes for a slice result; parse with readPreview(). */
  getPreview(sliceId: string): Promise<ArrayBuffer>
  exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport>
  release(id: string): void
}
