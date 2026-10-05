// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/slicer: browser slicing on a WASM worker pool. See README.md.
import type { SlicerHost } from '@slicerx/contracts'
import { createFakeSlicer, type FakeSlicerOptions } from './fake'
import { createWasmSlicer } from './pool'

export { createFakeSlicer, syntheticPreview, type FakeSlicerOptions } from './fake'
export { createWasmSlicer, type PoolOptions } from './pool'
export { decodeParts, encodeParts } from './parts'
export { stitchPreview } from './stitch'
// The preview reader, SXPV constants and slice types, so embedders need one package.
export {
  FEATURE,
  SXPV_FLAG_TRAVELS,
  SXPV_HEADER_BYTES,
  SXPV_MAGIC,
  SXPV_SEGMENT,
  SXPV_SEGMENT_BYTES,
  SXPV_TRAVEL_BYTES,
  SXPV_VERSION,
  readPreview,
  type FeatureId,
  type PreviewBuffers,
} from '@slicerx/contracts/preview'
export type {
  GcodeExport,
  GcodeTarget,
  MeshHandle,
  MeshPart,
  Plate,
  PlateObject,
  ProjectMetadata,
  SliceOptions,
  SliceProgress,
  SliceRequest,
  SliceResult,
  SliceStats,
  SliceWarning,
  SlicerHost,
} from '@slicerx/contracts/slice'
export type { PrintConfig } from '@slicerx/contracts/settings'

// The published build defines this as the module's path next to dist/index.js;
// from source, the module is the generated copy in pkg/.
declare const __SX_WASM_URL__: string | undefined

function defaultWasmUrl(): URL {
  return typeof __SX_WASM_URL__ === 'string' ? new URL(__SX_WASM_URL__, import.meta.url) : new URL('../pkg/sx_wasm.wasm', import.meta.url)
}

export interface WebSlicerOptions {
  /** Worker count; defaults to navigator.hardwareConcurrency (at most 16). */
  workers?: number
  /** URL of sx_wasm.wasm; defaults to the copy in this package's pkg/ folder. */
  wasmUrl?: string | URL
  /** Use the synthetic slicer instead of the WASM pool. */
  fake?: boolean | FakeSlicerOptions
}

/** Browser slicer host: a WASM worker pool, or the synthetic slicer when `fake` is set. */
export function createWebSlicer(opts: WebSlicerOptions = {}): Promise<SlicerHost> {
  if (opts.fake) return Promise.resolve(createFakeSlicer(typeof opts.fake === 'object' ? opts.fake : {}))
  const wasm = opts.wasmUrl ?? defaultWasmUrl()
  return createWasmSlicer(opts.workers === undefined ? { wasm } : { wasm, workers: opts.workers })
}
export { sliceClock } from './clock'
