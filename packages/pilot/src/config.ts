// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.config.json. The model id always comes from here, never from code;
// DEFAULT_CONFIG mirrors pilot.config.example.json for hosts without a file.
import type { PilotConfig } from '@slicerx/contracts'
import { z } from 'zod'
import example from '../pilot.config.example.json'

const schema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  maxSteps: z.number().int().min(1).max(64),
  maxToolCalls: z.number().int().min(1).max(200),
  reasoning: z.enum(['low', 'medium', 'high']).optional(),
  webSearch: z.boolean().optional(),
  models: z.object({ huginn: z.string().min(1).optional(), muninn: z.string().min(1).optional() }).optional(),
  modelChoice: z.string().min(1).optional(),
  billing: z.enum(['plan', 'key']).optional(),
})

export function parsePilotConfig(input: unknown): PilotConfig {
  const parsed = schema.parse(input)
  const out: PilotConfig = { provider: parsed.provider, model: parsed.model, maxSteps: parsed.maxSteps, maxToolCalls: parsed.maxToolCalls }
  if (parsed.baseUrl !== undefined) out.baseUrl = parsed.baseUrl
  if (parsed.reasoning !== undefined) out.reasoning = parsed.reasoning
  if (parsed.webSearch !== undefined) out.webSearch = parsed.webSearch
  if (parsed.models !== undefined) {
    const models: NonNullable<PilotConfig['models']> = {}
    if (parsed.models.huginn !== undefined) models.huginn = parsed.models.huginn
    if (parsed.models.muninn !== undefined) models.muninn = parsed.models.muninn
    out.models = models
  }
  if (parsed.modelChoice !== undefined) out.modelChoice = parsed.modelChoice
  if (parsed.billing !== undefined) out.billing = parsed.billing
  return out
}

export const DEFAULT_CONFIG: PilotConfig = parsePilotConfig(example)
