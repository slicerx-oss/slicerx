// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's filaments: what the plate calls filament 1, 2, 3, each a material type and a color, as the app's
// filament rail shows them. A client adds one after the last and changes one's type or color; the slice config
// carries them as filament_type and filament_colour.
import { productName } from '@slicerx/contracts'

/** The most filaments a project holds, as in the app. */
export const MAX_FILAMENTS = 16

/** Material types a filament can be, the ones the app's filament dialog offers. */
export const FILAMENT_TYPES = ['PLA', 'PETG', 'PET', 'ABS', 'ASA', 'PC', 'PA', 'TPU', 'PVA', 'HIPS', 'PP', 'PPS', 'PEEK', 'BVOH', 'EVA'] as const

/** A new filament's color by its number, the app's defaults. */
const DEFAULT_COLORS = ['#f8f8f2', '#282a36', '#ff5555', '#50fa7b', '#8be9fd', '#ffb86c', '#bd93f9', '#f1fa8c']

export interface FilamentSetup {
  type: string
  /** #rrggbb, lower case. */
  color: string
}

export interface ProjectFilament extends FilamentSetup {
  /** 1-based, as the plate and the engine number filaments. */
  slot: number
  /** "set": a client set it; "profile": the type comes from the project's filament profile, the color is the default. */
  source: 'set' | 'profile'
}

/** "#FF0000", "ff0000" or "#ff0000aa" as "#ff0000"; anything else is refused. */
export function filamentColor(c: string): string {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c.trim())
  if (!m) throw new Error(`"${c}" is not a color. Give one as #rrggbb, such as #ff5500.`)
  return `#${m[1]!.toLowerCase()}`
}

/** "petg" as "PETG"; a type the app does not offer is refused, with the list. */
export function filamentType(t: string): string {
  const up = t.trim().toUpperCase()
  if (!(FILAMENT_TYPES as readonly string[]).includes(up)) throw new Error(`"${t}" is not a filament type ${productName()} knows. Use one of ${FILAMENT_TYPES.join(', ')}.`)
  return up
}

/**
 * Every filament of a project: as many as the highest one set (at least one), each the client's setup or, when not
 * set, the profile's type and the default color for its number.
 */
export function listFilaments(setup: Readonly<Record<number, FilamentSetup>>, profileType: string): ProjectFilament[] {
  const n = Math.max(1, ...Object.keys(setup).map(Number))
  return Array.from({ length: n }, (_, i) => {
    const slot = i + 1
    const own = setup[slot]
    return own ? { slot, ...own, source: 'set' as const } : { slot, type: profileType, color: DEFAULT_COLORS[i % DEFAULT_COLORS.length]!, source: 'profile' as const }
  })
}

/** The default setup of filament `slot`, for one added with nothing given. */
export function defaultFilament(slot: number, profileType: string): FilamentSetup {
  return { type: profileType, color: DEFAULT_COLORS[(slot - 1) % DEFAULT_COLORS.length]! }
}
