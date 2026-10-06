// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Messages between the pool and its workers.

import type { Collision, CollisionFix, FilamentMapInfo, PrimeTowerPlacement, VaryLayerCost } from '@slicerx/contracts'

export type ToWorker =
  | { type: 'init'; module: WebAssembly.Module; warmUp: boolean }
  | { type: 'load'; call: number; meshId: string; fileName: string; data: ArrayBuffer }
  | { type: 'release'; meshId: string }
  | { type: 'parts'; call: number; meshId: string }
  | { type: 'metadata'; call: number; fileName: string; data: ArrayBuffer }
  | { type: 'slice'; call: number; request: string; shard: number; shards: number }
  | { type: 'finalize'; call: number; data: ArrayBuffer; thumbnail?: { width: number; height: number; rgba: ArrayBuffer }; request?: string; collide?: string }

export interface ShardInfo {
  layerCount: number
  first: number
  last: number
  layerZ: number[]
  layerTimeS: number[]
  stats: { time_s: number; filament_mm: number[]; filament_g: number[]; cost: number; tool_changes: number }
  stageMicros: Record<string, number>
  warnings: { code: string; message: string; layer?: number }[]
  toolCount: number
  /** Where the prime tower stands (every shard carries the same). */
  primeTower?: PrimeTowerPlacement | null
  /** What variable layers cost against fixed ones (every shard carries the same). */
  varyLayerCost?: VaryLayerCost | null
  /** The filament map (every shard carries the same). */
  filamentMap?: FilamentMapInfo | null
  /** By object: the collision check's facts (shard 0 only) and what this shard's moves meet, as numbers for finalize. */
  collide?: { meta: unknown; hits: number[] } | null
}

export interface MeshInfo {
  id: number
  name: string
  triangles: number
  hash: string
  bboxMm: [number, number, number]
  min: [number, number, number]
  max: [number, number, number]
  parts: { name: string; slot: number; color: string | null; triangles: number }[]
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'loaded'; call: number; info: MeshInfo }
  | { type: 'parts'; call: number; data: ArrayBuffer }
  | { type: 'metadata'; call: number; info: unknown }
  | { type: 'sliced'; call: number; gcode: ArrayBuffer; sxpv: ArrayBuffer; info: ShardInfo; ms: number }
  | { type: 'finalized'; call: number; data: ArrayBuffer; format: 'gcode' | 'bgcode'; timeS?: number; prepareS?: number; layerTimeS?: number[]; fileName?: string; layerLines?: number[]; progressLines?: number[]; collisions?: Collision[]; collisionFixes?: CollisionFix[] }
  | { type: 'error'; call: number; message: string }
