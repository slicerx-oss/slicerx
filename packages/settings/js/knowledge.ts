// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed view of knowledge.json, which scripts/gen-knowledge.mjs compiles from knowledge/.
import knowledgeJson from '../knowledge.json'

export interface Ranged {
  min?: number
  max?: number
  typical: number
  src: string[]
}

export interface MaterialKnowledge {
  name: string
  category?: string
  orcaType?: string
  nozzleTemp?: Ranged
  firstLayerTemp?: Ranged
  bedTemp?: Ranged
  chamberTemp?: Ranged
  enclosure?: string
  cooling: { fanMin?: number; fanMax?: number; overhangFan?: number; noFanLayers?: number; minLayerTime?: number; src: string[] }
  flowRatio?: Ranged
  maxFlow: { standard?: number; highFlow?: number; src: string[] }
  retraction: { directDrive?: number; src: string[] }
  pressureAdvance: { directDrive?: number; bowden?: number; src: string[] }
  density?: number
  nozzle: { abrasive: boolean; hardenedRequired: boolean; minDiameter?: number; src: string[] }
  dryingNeed?: string
  softeningTemp?: number
  /** The safe layer height band as a share of the nozzle diameter. */
  layerBand?: { min?: number; max?: number; typical?: number; src: string[] }
  /** What sleipnir should do for this material, in plain sentences. */
  smartLayerNotes?: { quality?: string; strength?: string; thinLayerCooling?: string; src: string[] }
  /** Speed limits the material itself sets. */
  speeds?: { printMin?: number; printMax?: number; outerWallMax?: number; firstLayerMax?: number; firstLayerTypical?: number; src: string[] }
  /** Research on sleipnir for this material: the layer height window as a share of the nozzle, when it differs from 25 to 75 percent. */
  smartLayer?: { minRatio?: number; maxRatio?: number; modes?: { quality?: { minRatio?: number; maxRatio?: number }; strength?: { minRatio?: number; maxRatio?: number } }; note?: string; src: string[] }
  /** The minimum layer time thin layers need, from the sleipnir research for the material's family. */
  coolingGuard?: { minLayerTime: number; note?: string; src: string[] }
  /** Retraction speed the material suggests, in mm/s. */
  retractionSpeed?: Ranged
  firstLayer?: { fanOffLayers?: number; speed?: number; bedNote?: string; squishNote?: string; src: string[] }
  /** Wall and infill hints. */
  structure?: { wallsMin?: number; wallsTypical?: number; wallsNote?: string; patternHint?: string; densityNote?: string; src: string[] }
  /** How supports pair with the material: interface materials, the soluble partner, Z gap and interface layers. */
  supports?: { interfaceMaterials: string[]; solubleMaterial?: string; solubleDissolve?: string; topZ?: number; interfaceLayers?: number; note?: string; src: string[] }
  /** Values mimir starts from, by Orca key. */
  pilotDefaults?: Record<string, number>
  /** How each build plate suits the material, with the bed range for it when the knowledge base gives one. */
  plates: { plate: string; fit: string; min?: number; max?: number }[]
  /** Numeric leaves of the ranges, by dotted path (`cooling.fan_max_pct.min`). */
  paths: Record<string, number>
}

export interface PrinterKnowledge {
  name: string
  vendor?: string
  firmware?: string
  extruder?: string
  build?: { x?: number; y?: number; z?: number; zDefault?: number; src: string[] }
  hotend: { maxTemp?: number; nozzleDiameters?: number[]; nozzleMaterials?: string[]; stockNozzle?: { diameter?: number; material?: string }; highFlow: boolean; maxFlow?: number; src: string[] }
  bed: { maxTemp?: number; src: string[] }
  enclosure: { type?: string; chamberHeating?: string; src: string[] }
  motion: { maxSpeed?: number; maxAccel?: number; src: string[] }
  materials: { recommended?: string[]; possible?: string[]; notRecommended?: string[]; unlisted?: string[] }
  baselineProcess?: string
  baseline?: { values: Record<string, number | string | boolean>; src: string[] }
}

export interface KChange {
  key: string
  op: 'set' | 'at_least' | 'at_most' | 'increase_by' | 'decrease_by' | 'multiply' | 'enable' | 'disable'
  value?: number | string | boolean
  valueFrom?: { nozzle_factor?: number; round_to?: number; filament_range?: string; position?: number; filament?: string; calibration?: string; field?: string; factor?: number }
  priority: 'core' | 'supporting'
  why: string
  src: string[]
}

export interface GoalKnowledge {
  label: string
  defaultLevel?: string
  implies?: string[]
  levels: Record<string, { extends?: string; changes: KChange[] }>
  coolingRule?: { appliesTo: string[]; change: KChange }
  materialHints: { prefer?: string[]; acceptable?: string[]; avoid?: string[]; note?: string }
  materialNotes?: Record<string, string>
  caveats: { text: string; src: string[] }[]
  alwaysShowCaveats: boolean
  advice: { text: string; kind: 'material' | 'hardware' | 'orientation' | 'environment' | 'workflow'; src: string[] }[]
  constraints: { text: string; src: string[] }[]
  checks: string[]
  src: string[]
}

export interface PairRule {
  goals: string[]
  resolution?: string
  keep?: Record<string, string>
  ask?: string
  never?: string
  tellUser?: string
}

export interface CalibrationWrite {
  key: string
  op: KChange['op']
  value?: number | string | boolean
  valueFrom?: KChange['valueFrom']
  why?: string
}

export interface Knowledge {
  materials: Record<string, MaterialKnowledge>
  printers: Record<string, PrinterKnowledge>
  goals: Record<string, GoalKnowledge>
  pairs: PairRule[]
  calibrations: Record<string, CalibrationWrite[]>
}

export const K = knowledgeJson as unknown as Knowledge
