// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arguments and the engine call shared by the geometry tools. No Node imports.
import { z } from 'zod'

export const vec3 = z.tuple([z.number(), z.number(), z.number()])
export const modelArg = z.string().min(1).describe('Absolute path to an STL file, an http(s) URL, or a built-in model such as sample:x-mark or sample:cube-20')

export type GeomCall = (op: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>
