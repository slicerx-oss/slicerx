// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Easy settings as the app stores them. Old saved values (silent, standard, sport, ludicrous; supports everywhere; sleipnir modes) are
// read as their new names (packages/settings/docs/tiers.md) and only the new names are ever written.
import type { EasySettings, SpeedPreset, SupportMode } from '@slicerx/contracts'

const SPEED: Record<string, SpeedPreset> = { silent: 'quality', gentle: 'quality', standard: 'balanced', sport: 'fast', ludicrous: 'fastest', maximum: 'fastest', quality: 'quality', balanced: 'balanced', fast: 'fast', fastest: 'fastest' }

type Loose = Omit<EasySettings, 'varyLayerHeight' | 'smartLayer'> & { varyLayerHeight?: boolean | undefined; smartLayer?: EasySettings['smartLayer'] | undefined }

export function normalizeEasy(e: Loose): EasySettings {
  const { smartLayer, ...rest } = e
  const supports: SupportMode = e.supports === 'everywhere' ? 'auto' : e.supports
  return { ...rest, speed: SPEED[e.speed] ?? 'balanced', supports, varyLayerHeight: e.varyLayerHeight ?? (smartLayer !== undefined && smartLayer !== 'off') }
}
