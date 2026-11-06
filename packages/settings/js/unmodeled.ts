// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The values a project's settings hold for keys the schema has no setting for, which a kept printer G-code may read
// (script-keys.ts).
import type { SettingValue } from '@slicerx/contracts/settings'
import { settingDef } from './schema'

/** Key names that hold a secret or run a program, which never leave the file. */
const PRIVATE = /password|apikey|api_key|access_code|secret|token|bearer|^post_process$|^printhost_/i

/**
 * A project's values for the keys its settings hold that the schema has no setting for, as the file holds them: a
 * plain value or a flat list of them. Secrets and post-processing commands stay behind.
 */
export function unmodeledValues(settings: Readonly<Record<string, unknown>>): Record<string, SettingValue> {
  const plain = (x: unknown): boolean => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (settingDef(k) || PRIVATE.test(k)) continue
    if (plain(v) || (Array.isArray(v) && v.every(plain))) out[k] = v as SettingValue
  }
  return out
}
