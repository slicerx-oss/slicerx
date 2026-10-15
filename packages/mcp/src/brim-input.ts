// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'

const object = z.string().trim().min(1).describe('Object id or unique name on the shown plate')
export const brimReadInput = z.object({ object: object.optional() }).strict()
export const brimEditInput = z.object({
  object,
  action: z.enum(['add', 'move', 'resize', 'remove', 'clear', 'generate']),
  revision: z.string().min(1).describe('Revision from a fresh app_brim_ears read; edits refuse stale reads'),
  x_mm: z.number().finite().optional(),
  y_mm: z.number().finite().optional(),
  diameter_mm: z.number().finite().min(5).max(20).optional().describe('World diameter from 5 to 20 mm, rounded to 0.1 mm'),
  indices: z.array(z.number().int().min(0)).min(1).max(2000).optional().describe('Zero-based ear indices from app_brim_ears; move takes exactly one'),
  max_angle: z.number().finite().min(0).max(180).optional(),
  detection_mm: z.number().finite().min(0).optional(),
}).strict().superRefine((i, ctx) => {
  const fields: string[] = {
    add: ['x_mm', 'y_mm', 'diameter_mm'], move: ['x_mm', 'y_mm', 'indices'],
    resize: ['indices', 'diameter_mm'], remove: ['indices'], clear: [],
    generate: ['max_angle', 'detection_mm', 'diameter_mm'],
  }[i.action]
  for (const key of ['x_mm', 'y_mm', 'diameter_mm', 'indices', 'max_angle', 'detection_mm'] as const) {
    if (i[key] !== undefined && !fields.includes(key)) ctx.addIssue({ code: 'custom', message: `${key} is not used by ${i.action}`, path: [key] })
  }
  const required = i.action === 'add' ? ['x_mm', 'y_mm'] : i.action === 'move' ? ['x_mm', 'y_mm', 'indices'] : i.action === 'resize' ? ['indices', 'diameter_mm'] : i.action === 'remove' ? ['indices'] : []
  for (const key of required) if (i[key as keyof typeof i] === undefined) ctx.addIssue({ code: 'custom', message: `${key} is required for ${i.action}`, path: [key] })
  if (i.action === 'move' && i.indices?.length !== 1) ctx.addIssue({ code: 'custom', message: 'move needs one ear index', path: ['indices'] })
})
