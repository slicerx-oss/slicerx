// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shapes the cloud service returns (camelCase JSON), checked at the boundary.
import { z } from 'zod'

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

/** The `sx slice` result JSON (`sx schema result`); only the fields the client reads are listed. */
export const sliceReport = z.looseObject({
  schemaVersion: z.number().int(),
  engine: z.string(),
  layerCount: z.number().int().nonnegative(),
  layerZ: z.array(z.number()),
  layerTimeS: z.array(z.number()),
  stats: z.object({
    timeS: z.number(),
    filamentMm: z.array(z.number()),
    filamentG: z.array(z.number()),
    cost: z.number(),
    toolChanges: z.number().int(),
  }),
  stageMicros: z.record(z.string(), z.number()).default({}),
  wallMs: z.number(),
  warnings: z
    .array(z.looseObject({ code: z.string(), message: z.string(), layer: z.number().int().optional() }))
    .default([]),
  gcodeBytes: z.number().int().nonnegative(),
  gcodeSha256: z.string(),
  previewBytes: z.number().int().nonnegative(),
})
export type SliceReport = z.infer<typeof sliceReport>

export const jobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
export type JobStatus = z.infer<typeof jobStatus>

export const cloudJob = z.object({
  id,
  userId: id,
  name: z.string(),
  status: jobStatus,
  progress: z.number().min(0).max(1),
  stage: z.string().nullable(),
  request: z.record(z.string(), z.unknown()),
  targetPrinterId: id.nullable(),
  result: sliceReport.nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  gcodeUrl: z.string().optional(),
  previewUrl: z.string().optional(),
})
export type CloudJob = z.infer<typeof cloudJob>

export const deviceKind = z.enum(['link', 'desktop', 'web', 'mobile'])
export type DeviceKind = z.infer<typeof deviceKind>

export const cloudDevice = z.object({ id, userId: id, kind: deviceKind, name: z.string(), createdAt: z.string() })
export type CloudDevice = z.infer<typeof cloudDevice>

export const bridgePrinter = z.object({
  id,
  name: z.string(),
  driver: z.string().nullable(),
  model: z.string().nullable(),
  deviceId: id.nullable(),
  localId: z.string().nullable(),
  printerProfileId: id.nullable(),
  deleted: z.boolean(),
})
export type BridgePrinter = z.infer<typeof bridgePrinter>

export const deliveryState = z.enum([
  'offered',
  'downloaded',
  'awaiting_approval',
  'approved',
  'declined',
  'uploaded',
  'printing',
  'failed',
  'expired',
  'canceled',
])
export type DeliveryState = z.infer<typeof deliveryState>

export const delivery = z.object({
  id,
  jobId: id,
  printerId: id,
  printerLocalId: z.string().nullable(),
  state: deliveryState,
  message: z.string().nullable(),
  fileName: z.string(),
  sha256: z.union([sha256, z.literal('')]),
  bytes: z.number().int().nonnegative(),
  gcodePath: z.string().startsWith('/v1/'),
  stats: z.object({ timeS: z.number(), filamentG: z.number() }),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type Delivery = z.infer<typeof delivery>

export const meshUpload = z.object({ sha256, bytes: z.number().int().optional() })

/** `GET /v1/access`: whether the caller is invited to cloud slicing, with the limits. */
export const cloudAccess = z.union([
  z.object({
    invited: z.literal(true),
    jobsPerDay: z.number().int(),
    jobsToday: z.number().int(),
    maxUploadBytes: z.number().int(),
  }),
  z.object({ invited: z.literal(false) }),
])
export type CloudAccess = z.infer<typeof cloudAccess>

export const aboutService = z.object({ name: z.string(), version: z.string(), sourceUrl: z.string().optional() })
export type AboutService = z.infer<typeof aboutService>
