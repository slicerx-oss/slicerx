// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The permission policy file: mimir's Allow, Ask first and Off per
// action class, read once at startup. The server has no tool that writes it,
// so a model can never loosen its own permissions.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PermissionPolicy } from '@slicerx/contracts'
import { DEFAULT_POLICY, PERMISSION_LABELS } from '@slicerx/contracts'
import { normalizePolicy } from '@slicerx/pilot'

export const DEFAULT_POLICY_PATH = join(homedir(), '.config', 'slicerx', 'mcp-policy.json')

export interface LoadedPolicy {
  policy: PermissionPolicy
  /** File the policy came from, or undefined for the built-in defaults. */
  path: string | undefined
}

/**
 * Reads the policy from `path`, or from ~/.config/slicerx/mcp-policy.json when
 * that exists, else the defaults: slicing allowed, queueing, starting and
 * profile writes ask first. Unknown or malformed entries fall
 * back to the default for that class.
 */
export function loadPolicy(path?: string): LoadedPolicy {
  const file = path ?? (existsSync(DEFAULT_POLICY_PATH) ? DEFAULT_POLICY_PATH : undefined)
  if (!file) return { policy: normalizePolicy(DEFAULT_POLICY), path: undefined }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`Could not read the permission policy ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { policy: normalizePolicy(raw), path: file }
}

/** The policy as clients see it through slicerx_get_policy. */
export function describePolicy(loaded: LoadedPolicy): Record<string, unknown> {
  return {
    source: loaded.path ?? 'built-in defaults',
    classes: Object.fromEntries(
      Object.entries(loaded.policy.classes).map(([k, mode]) => [k, { mode, ...PERMISSION_LABELS[k as keyof typeof PERMISSION_LABELS] }]),
    ),
    printers: loaded.policy.printers ?? {},
    note: 'Reading is always allowed. The user edits this file; no tool can change it.',
  }
}
