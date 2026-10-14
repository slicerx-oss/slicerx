// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'

const plate = z.union([z.number().int().min(1), z.string().min(1).max(80)]).describe('Plate number from 1, or a stable id from app_plates')
const name = z.string().trim().min(1).max(40)
const slot = z.number().int().min(1)
export const appPlateSettings = z.object({
  bedType: z.enum(['cool', 'engineering', 'high-temp', 'textured-pei', 'smooth-pei']).optional(),
  sequence: z.enum(['by-layer', 'by-object']).optional(),
  filamentOrder: z.array(slot).max(256).refine((v) => new Set(v).size === v.length, 'Filament slots must be unique').optional(),
  slotMap: z.record(z.string().regex(/^[1-9]\d*$/), slot).optional(),
  nozzleMap: z.array(z.union([z.literal(1), z.literal(2)])).max(256).optional(),
}).strict()

export const appPlateInputs = {
  add: z.object({ name: name.optional(), settings: appPlateSettings.optional() }).strict(),
  duplicate: z.object({ plate, name: name.optional() }).strict(),
  rename: z.object({ plate, name }).strict(),
  settings: z.object({ plate, settings: appPlateSettings, replace: z.boolean().default(false).describe('Replace all overrides instead of merging; {} clears them') }).strict(),
  remove: z.object({ plate, deleteObjects: z.boolean().default(false).describe('Required for a populated plate: delete its objects too') }).strict(),
  move: z.object({ plate, objects: z.array(z.string().min(1)).min(1).max(256).refine((v) => new Set(v).size === v.length, 'Object ids must be unique') }).strict(),
}
