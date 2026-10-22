// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/cloud: the client for cloud slicing, delivery to printers and
// profile sync. See README.md.
export {
  createCloudClient,
  type CloudClient,
  type CloudClientOptions,
  type CloudSliceObject,
  type CloudSliceOptions,
  type CloudSliceRequest,
  type LinkPrinterInput,
  type MeshData,
  type PackedMesh,
  packedSize,
  type PlateInput,
  type SubmitJobInput,
  type WaitOptions,
} from './client'
export { type Gzip, sizeText, streamGzip } from './compress'
export { createDeliveryAgent, type DeliveryAgent, type DeliveryAgentOptions, type DeliveryEvent } from './delivery'
export { sha256Hex } from './hash'
export { memoryStore, type KeyValueStore } from './kv'
export {
  createJobOutbox,
  type FlushReport,
  type JobOutbox,
  type OutboxEntry,
  type OutboxOptions,
  type SubmitOutcome,
} from './outbox'
export { type CloudErrorCode, type CloudResult, isRetryable } from './result'
export type {
  AboutService,
  BridgePrinter,
  CloudAccess,
  CloudDevice,
  CloudJob,
  Delivery,
  DeliveryState,
  DeviceKind,
  JobStatus,
  SliceReport,
} from './schemas'
export { cloudRoutedSlicer, createCloudSlicer, type CloudRouteOptions, type CloudSlicerOptions } from './slicer-host'
export * from './sync/index'
