// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir is on for a fresh plate. It stays off only where the person chose that: the layer height picker or the
// sleipnir command (both mark it in easyTouched), or a goal that prints fixed layers (Draft). An opened Orca or
// Bambu Studio project turns it off for that project only, so the next fresh plate has it back.
import type { EasySettings } from '@slicerx/contracts'

const TIERS = ['draft', 'standard', 'fine', 'strong'] as const
/**
 * The goals that print fixed layers, as easy-map.json's goals say (varyLayerHeight false). Kept here, not read through
 * goalEasy: the store reads this at startup, and easy.ts brings the settings defaults with it (apps/web bundle-size
 * budget). test/sleipnir-default.test.ts checks it against goalEasy for every goal.
 */
const FIXED_LAYERS: readonly string[] = ['draft']

export function freshVary(s: { easy: Pick<EasySettings, 'varyLayerHeight'>; easyTouched: readonly string[]; goal: string }): boolean {
  if (s.easyTouched.includes('varyLayerHeight')) return s.easy.varyLayerHeight ?? true
  if ((TIERS as readonly string[]).includes(s.goal)) return !FIXED_LAYERS.includes(s.goal)
  return true
}
