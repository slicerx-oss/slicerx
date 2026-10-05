// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings schema types. Keys are OrcaSlicer's own names.
import type { SliceStage } from './slice'

export type SettingSection = 'process' | 'filament' | 'printer'
/**
 * Scalar types first, then the per-extruder lists Orca stores as arrays
 * (`floats` is a list of numbers, `points` a list of [x, y] pairs). A
 * `floatOrPercent` value is a string such as `0.42` or `110%`, as in Orca.
 */
export type SettingType =
  | 'float' | 'int' | 'bool' | 'percent' | 'floatOrPercent' | 'enum' | 'string' | 'gcode' | 'point'
  | 'floats' | 'ints' | 'bools' | 'percents' | 'floatsOrPercents' | 'enums' | 'strings' | 'points' | 'pointsGroups'
export type SettingValue = number | boolean | string | number[] | boolean[] | string[] | [number, number][] | [number, number][][]
export type SettingUnit =
  | 'mm' | 'mm/s' | 'mm/s2' | 'mm3/s' | '%' | 'C' | 's' | 'g/cm3' | 'deg' | 'money/kg'
  | 'mm3' | 'layers' | 'Hz' | 'delta-C' | 'money/h'
export type SettingMode = 'simple' | 'advanced' | 'expert' | 'develop' | 'hidden'
export type SettingIntent = 'quality' | 'strength' | 'speed' | 'supports' | 'adhesion' | 'multicolor' | 'effects' | 'output'
export type PilotRule = 'edit' | 'guarded' | 'read'

/** A key is enabled only while every condition holds, as in Orca's own toggles. */
export interface SettingCondition {
  key: string
  op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'notin'
  value: SettingValue | SettingValue[]
}

export interface SettingDef {
  /** Orca key, such as `layer_height` or `sparse_infill_density`. */
  key: string
  section: SettingSection
  type: SettingType
  unit?: SettingUnit
  default: SettingValue
  /** Recommended range. Where the knowledge catalog gives Pilot bounds these are those bounds. */
  min?: number
  max?: number
  /** Orca's own limits, only present when they differ from `min` and `max`; null means Orca sets no limit. Outside them Orca rejects the value. */
  orcaMin?: number | null
  orcaMax?: number | null
  step?: number
  /** Orca's enum strings, in Orca's order. */
  /** The value 0 means automatic (line widths take the nozzle diameter) and is always allowed, whatever `min` says. */
  auto?: boolean
  enumValues?: string[]
  enumLabels?: string[]
  /** Enum values the schema lists but the SlicerX engine cannot print yet. Choosing one is allowed (imported projects use them) and validation says so. */
  unavailableValues?: string[]
  /** Old enum strings that read as a current value (for example athena for aegis). */
  enumAliases?: Record<string, string>
  label: string
  help?: string
  /** One or two plain sentences on what the setting does and when to change it (packages/settings/notes.json). Shown in its tooltip. */
  note?: string
  /** UI group: quality, strength, speed, cooling, temperature, extrusion, support, adhesion, multimaterial, machine, gcode, and so on. */
  group: string
  /** Orca's own category string, when it has one. */
  category?: string
  mode: SettingMode
  /** What the key is for, for grouping the Advanced and Expert tiers. Process keys only. */
  intent?: SettingIntent
  /** `multicolor`: show the key only when two or more filaments are in use (see `isVisible`). */
  showWhen?: 'multicolor'
  /** Shown in Easy mode (usually driven by an Easy control rather than edited directly). */
  easy?: boolean
  /** Orca writes `nil` for "use the other profile's value"; such a key is left out of the config. */
  nullable?: boolean
  enabledWhen?: SettingCondition[]
  /** Pilot edit rule from knowledge/settings.yaml, when the key is in the catalog. */
  pilot?: PilotRule
  /** One line each: what raising or lowering the value does to the print. Used for diff reasons. */
  effect?: { increase?: string; decrease?: string }
  /** First slice stage this key invalidates. */
  invalidates: SliceStage
}

/**
 * A fully resolved config: every key the engine reads, with typed values.
 * Percent values are numbers (15 means 15 percent). Orca's string forms are
 * converted on import and restored on export.
 */
export interface PrintConfig {
  layer_height: number
  initial_layer_print_height: number
  wall_loops: number
  top_shell_layers: number
  bottom_shell_layers: number
  sparse_infill_density: number
  sparse_infill_pattern: string
  line_width: number
  brim_type: string
  brim_width: number
  enable_support: boolean
  nozzle_diameter: number[]
  nozzle_temperature: number[]
  printable_area: [number, number][]
  printable_height: number
  gcode_flavor: string
  [key: string]: SettingValue
}

/** sleipnir, the automatic variable layer height. Shown as Off, sleipnir: Quality and sleipnir: Strength. */
export type SmartLayerMode = 'off' | 'quality' | 'strength'
export const SMART_LAYER_LABELS: Record<SmartLayerMode, string> = { off: 'Off', quality: 'sleipnir: Quality', strength: 'sleipnir: Strength' }

/** The stored Speed names. Labels live in packages/settings/easy-map.json (`controls.speed.labels`). */
export type SpeedPreset = 'quality' | 'balanced' | 'fast' | 'fastest'
/** Old Speed names, still read from saved projects, presets and links. Never write them. */
export type LegacySpeedPreset = 'silent' | 'standard' | 'sport' | 'ludicrous' | 'gentle' | 'maximum'
export type SupportMode = 'off' | 'auto' | 'painted'
/** Old support name, still read: `everywhere` reads as `auto`. Never write it. */
export type LegacySupportMode = 'everywhere'

/** The Easy mode controls from the Prepare workspace. */
export interface EasySettings {
  /** 0 to 100; higher means thinner layers. */
  detail: number
  /** 0 to 100; more walls and denser infill. */
  strength: number
  speed: SpeedPreset | LegacySpeedPreset
  supports: SupportMode | LegacySupportMode
  brim: boolean
  /** The Vary layer height switch under Detail: automatic variable layer height, bounded by Detail. Off when absent. */
  varyLayerHeight?: boolean
  /** Old sleipnir mode, read when `varyLayerHeight` is absent. Never write it. */
  smartLayer?: SmartLayerMode
}

export type EasyGoal = 'draft' | 'standard' | 'fine' | 'strong'

/** Same table as `goals` in packages/settings/easy-map.json; a test keeps them equal. */
export const EASY_GOALS: Record<EasyGoal, EasySettings> = {
  draft: { detail: 0, strength: 10, speed: 'fast', supports: 'auto', brim: true, varyLayerHeight: false },
  standard: { detail: 40, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true },
  fine: { detail: 80, strength: 30, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true },
  strong: { detail: 40, strength: 85, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true },
}

export const EASY_DEFAULTS: EasySettings = { detail: 40, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true }

/** A material, printer and nozzle: what a plan switches between. */
export interface SetupRef {
  /** Knowledge printer id, such as `prusa_mk4s`. */
  printer: string
  nozzleDiameter: number
  /** Knowledge filament id, such as `petg`. */
  filament: string
  process?: string
  /** Hotend flavor, when the printer offers both. Defaults to `standard`. */
  hotend?: 'standard' | 'high_flow'
  /** Fitted nozzle material (`brass`, `hardened_steel`, ...). Defaults to the printer's stock nozzle. */
  nozzleMaterial?: string
}

/** Where a planned value comes from. */
export type ChangeOrigin = 'printer' | 'filament' | 'nozzle' | 'intent' | 'calibration' | 'profile'

export interface SettingChange {
  key: string
  label: string
  section: SettingSection
  unit?: SettingUnit
  /** The value in the base config or the old setup; null when neither has one. */
  before: SettingValue | null
  after: SettingValue
  reason: string
  /** Source ids from knowledge/sources or Orca profile paths (`orca:...`). */
  sources: string[]
  origin: ChangeOrigin
  /** The key's mimir class from the settings catalog. `read` keys are shown but never written. */
  klass: PilotRule
  /** `ask` when a guarded key lands outside the filament's range. */
  approval: 'none' | 'ask'
  /** The intent goal that asked for it, when origin is `intent`. */
  goal?: string
  priority?: 'core' | 'supporting'
}

/** A value moved to fit a limit. */
export interface PlanClamp {
  key: string
  requested: SettingValue
  applied: SettingValue
  by: 'bounds' | 'filament' | 'printer'
  limit: number
  reason: string
}

/** A value the plan will not write. */
export interface PlanRefusal {
  key: string
  requested: SettingValue
  reason: string
}

export interface PlanAdvice {
  text: string
  kind: 'material' | 'hardware' | 'orientation' | 'environment' | 'workflow'
  sources: string[]
}

export interface SettingsPlan {
  from: SetupRef
  to: SetupRef
  changes: SettingChange[]
  /** Keys the plan could not decide, with why. */
  unresolved: { key: string; reason: string }[]
  /** Problems with the new setup: nozzle too small, hotend too cool, printer not suited to the material. */
  warnings: string[]
  /** Every value moved to fit a bound, a filament range or a printer limit. */
  clamps: PlanClamp[]
  /** Values past a printer limit, or on a read only key: not written. */
  refused: PlanRefusal[]
  /** Hard stops, such as an abrasive material on a soft nozzle. `changes` is empty while any exist. */
  blockers: string[]
  /** Questions to ask the user before applying. */
  questions: string[]
  /** Notes that must be shown with the plan (food contact and similar). */
  caveats: { text: string; sources: string[] }[]
  /** Hardware, orientation and workflow suggestions. Never applied automatically. */
  advice: PlanAdvice[]
  /** What was given up when goals conflicted. */
  tellUser: string[]
  computedMs: number
}

export interface PlanGoal {
  /** A goal id from knowledge/intents, such as `strength`. */
  id: string
  /** A level of that goal (`standard`, `max`, `draft`); its default level when omitted. */
  level?: string
  /** Said by the user (true, the default) or inferred from the model or material. */
  stated?: boolean
}

export interface PlanIntent {
  goals: PlanGoal[]
}

/** A stored calibration result for one spool, printer and nozzle. */
export interface CalibrationResult {
  /** A calibration id from knowledge/workflows/calibration, such as `pressure_advance`. */
  id: string
  /** Result fields by name, such as `{ value: 0.045 }` or `{ best_c: 235 }`. */
  values: Record<string, number>
  printer?: string
  filament?: string
  nozzleDiameter?: number
}

export interface ProfileRef {
  id: string
  name: string
  section: SettingSection
  vendor?: string
  /** Name of the parent profile, as in Orca's `inherits`. */
  inherits?: string
}

export type IssueSeverity = 'error' | 'warning' | 'info'

/** A validation problem or a conflict between keys. `fix` is a suggested edit, never applied silently. */
export interface SettingIssue {
  code: string
  severity: IssueSeverity
  keys: string[]
  message: string
  fix?: { key: string; value: SettingValue }
}

export interface ConfigDiffEntry {
  key: string
  label: string
  group: string
  unit?: SettingUnit
  before?: SettingValue
  after?: SettingValue
  kind: 'added' | 'removed' | 'changed'
  /** First slice stage the change invalidates. */
  stage: SliceStage
  /** Plain sentence for the Pilot diff card and the settings panel. */
  reason: string
}

/** Result of importing an Orca or Bambu Studio profile with its `inherits` chain resolved. */
export interface ProfileImport {
  name: string
  section: SettingSection
  /** Names from the profile itself up to the root of the chain. */
  chain: string[]
  config: PrintConfig
  /** Keys in the profile that neither the schema nor Orca's legacy rules know. Orca would drop them too. */
  unknownKeys: string[]
  /** Keys Orca drops on purpose: obsolete keys and keys only Bambu Studio and other forks define. */
  ignoredKeys: string[]
  /** Keys that were `nil` in the profile and left out. */
  nilKeys: string[]
  /** Keys whose value could not be read as the schema type and were skipped. */
  invalidKeys: string[]
}
