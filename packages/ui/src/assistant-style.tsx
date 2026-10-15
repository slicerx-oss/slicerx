// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { assistantBrand, onAssistantBrand } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { useTheme } from './theme-provider'

/** Accent only the assistant's surfaces, preserving product and status colors. */
export function AssistantStyle() {
  const brand = useSyncExternalStore(onAssistantBrand, assistantBrand, assistantBrand)
  const { theme } = useTheme()
  const accent = typeof brand.accent === 'string' ? brand.accent : brand.accent?.[theme.scheme]
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return null
  const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const ink = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]! > 0.179 ? '#000000' : '#ffffff'
  return <style>{`
    .sx-pilot, .fr-mimir, .ms, .pc, .set-sec[aria-labelledby="pilot-h"],
    [data-testid="tab-mimir"], [data-testid="settings-nav-pilot"], .mimir-btn {
      --purple: ${accent};
      --accent: ${accent};
      --on-grad: ${ink};
      --purple-tint: color-mix(in srgb, ${accent} 12%, transparent);
      --purple-ring: color-mix(in srgb, ${accent} 45%, transparent);
      --accent-tint: color-mix(in srgb, ${accent} 14%, transparent);
      --accent-ring: color-mix(in srgb, ${accent} 45%, transparent);
      --focus-ring: 2px solid ${accent};
      --focus-field: 0 0 0 3px color-mix(in srgb, ${accent} 14%, transparent);
    }
  `}</style>
}
