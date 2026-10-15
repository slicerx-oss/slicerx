// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const plane = z.union([
  z.object({ axis: z.enum(['x', 'y', 'z']), at: z.number().finite() }).strict(),
  z.object({ point: vector, normal: vector.refine((v) => Math.hypot(...v) >= 1e-9, 'The plane normal must be nonzero') }).strict(),
])

/** Shared by the command and the live app, before any geometry or state changes. */
export const cutInput = z.object({
  object: z.string().min(1).max(500).describe('One object id or unambiguous name on the shown plate'),
  plane: plane.describe('Plane in bed coordinates, millimeters: axis/at or point/normal'),
  keep: z.enum(['both', 'above', 'below']).default('both'),
  connector: z.object({
    kind: z.enum(['pin', 'dowel', 'dovetail']),
    diameter_mm: z.number().positive().max(50).default(5),
    depth_mm: z.number().positive().max(100).default(6),
    tolerance_mm: z.number().min(0).max(2).optional().describe('Fit clearance in millimeters; omitted uses the app fit clearance'),
    count: z.number().int().min(1).max(16).optional(),
    positions: z.array(vector).max(16).optional().describe('Pin or dowel positions on the plane in bed coordinates; omitted places them automatically'),
  }).strict().refine((c) => c.kind !== 'dovetail' || !c.positions?.length, 'Dovetails use automatic placement').optional(),
}).strict()
