// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'

const key = z.string().min(1).max(100)
const value = z.union([z.number().finite(), z.boolean(), z.string(), z.array(z.unknown())])

/** A patch clears inherited overrides first, then sets values. A key cannot occur in both. */
export const projectSettingsInput = z.object({
  changes: z.record(key, value).default({}),
  clear: z.array(key).max(512).default([]).describe('Remove these project overrides and use the current profile and Easy values again'),
}).strict().refine((i) => Object.keys(i.changes).length + i.clear.length > 0, 'Give changes or clear')
  .refine((i) => !i.clear.some((k) => Object.hasOwn(i.changes, k)), 'A setting cannot be changed and cleared in one patch')

export const projectSettingsReadInput = z.object({
  keys: z.array(key).max(512).optional().describe('Only these print setting keys; omitted, read all supported settings and read-only plate configuration keys'),
}).strict()
