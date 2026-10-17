// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { layerArg, targetArg } from './paint-target'

export { storedTarget } from './paint-target'
export const appPaintReadInput = z.object({ object: z.string().min(1), layer: layerArg })
export const appPaintPreviewInput = appPaintReadInput.extend({
  state: z.number().int().min(0).max(255).describe('Color filament slot; seam/support 1 or 2; fuzzy 1; 0 clears'),
  target: targetArg,
  part: z.number().int().min(0).optional().describe('Zero-based part index; omit for every part'),
  max_depth: z.number().int().min(0).max(10).optional(),
})
export const appPaintApplyInput = z.object({ preview: z.string().min(1) })
export const appPaintClearInput = appPaintReadInput.extend({ revision: z.string().min(1) })
