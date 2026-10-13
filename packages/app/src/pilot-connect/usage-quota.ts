// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the usage report (quota v2, under `v2` beside the v1 fields of /quota) into MimirUsage. The only file that
// knows the report's shape; a change to the wire format changes this file and nothing else. Anything missing or
// malformed reads as no report.
import type { MimirUsage } from './usage-model'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nums = (v: unknown): number[] | undefined => (Array.isArray(v) ? v.map((x) => num(x) ?? 0) : undefined)
const time = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function allowance(v: unknown): { used: number; resetsAt: string } | null {
  const r = rec(v)
  const used = num(r?.['used'])
  const resetsAt = time(r?.['resetsAt'])
  return used === null || resetsAt === null ? null : { used, resetsAt }
}

export function usageFromQuota(quota: unknown): MimirUsage | null {
  const r = rec(rec(quota)?.['v2'])
  if (!r) return null
  const day = allowance(r['day'])
  const limit = num(rec(r['perMinute'])?.['limit'])
  if (!day || limit === null) return null
  const daily = nums(r['daily'])
  return { day, hourly: nums(r['hourly']) ?? [], ...(daily ? { daily } : {}), perMinute: { limit } }
}
