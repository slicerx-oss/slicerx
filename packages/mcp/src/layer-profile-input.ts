// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'

const plate = z.union([z.number().int().min(1), z.string().min(1).max(80)]).describe('Plate number from 1, or a stable id from app_plates; the shown plate when left out')
const point = z.tuple([z.number().finite().min(0).max(10_000).describe('Height above the bed, mm'), z.number().finite().positive().max(10).describe('Layer height there, mm')])

export const layerProfileReadInput = z.object({ plate: plate.optional() }).strict()
export const layerProfileEditInput = z.object({
  plate: plate.optional(),
  action: z.enum(['set', 'reset']).describe('set: make points the plate profile; reset: clear it so the plate slices with sleipnir or its fixed layer height again'),
  points: z.array(point).min(1).max(200).optional().describe('For set: [height above the bed mm, layer height mm] pairs; sorted by height, straight between points and flat past the ends'),
  revision: z.string().min(1).max(100).optional().describe('The revision app_layer_profile read; when given, an edit after another change to the project is refused with busy'),
}).strict().superRefine((i, ctx) => {
  if (i.action === 'set' && !i.points) ctx.addIssue({ code: 'custom', message: 'points is required for set', path: ['points'] })
  if (i.action === 'reset' && i.points) ctx.addIssue({ code: 'custom', message: 'points is not used by reset', path: ['points'] })
})
