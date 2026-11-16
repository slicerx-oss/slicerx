// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's filaments: what the plate calls filament 1, 2, 3, each a material type and a color, as the app's
// filament rail shows them. A client adds one after the last and changes one's type or color; the slice config
// carries them as filament_type and filament_colour. The server's project.add_filament and project.set_filament and the
// mimir tab's tools of the same names keep what the project has by one rule, with the same words: adding a color the
// project already has in that material (one that looks the same, under SAME_COLOR_DE00) is refused with the filament
// to use, and so is changing a filament's material, since its parts and the spool it maps to count on it.
import { baseMaterial, colorDeltaE, COLOR_SLOT_MAX, productName, SAME_COLOR_DE00 } from '@slicerx/contracts'

/** The most filaments a project holds, as in the app. */
export const MAX_FILAMENTS = COLOR_SLOT_MAX

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

/** A filament by its number, as the server and the mimir tab list them. */
interface NumberedFilament {
  slot: number
  type: string
  color: string
}

/** What project.add_filament says about the colors it takes, in the server's and the tab's descriptions. */
export const ADD_FILAMENT_RULE = 'Add only a color something will print or paint in: a color the project already has in that material, or one close to it, is refused with the filament to use instead.'

/** What project.set_filament changes, the start of the server's and the tab's descriptions. */
export const SET_FILAMENT_LEAD = 'Change the color of a filament of the open project'

/** What project.set_filament says about a filament's material, in the server's and the tab's descriptions. */
export const SET_FILAMENT_RULE = 'Its material type stays: a type other than its own is refused, so add a filament with project.add_filament for another material.'

/**
 * The project's filament of `type` whose color looks the same as `color` (colorDeltaE under SAME_COLOR_DE00), the
 * nearest first, if there is one.
 */
export function sameFilament<F extends NumberedFilament>(all: readonly F[], type: string, color: string): F | undefined {
  return all
    .filter((f) => baseMaterial(f.type) === baseMaterial(type) && colorDeltaE(f.color, color) < SAME_COLOR_DE00)
    .sort((a, b) => colorDeltaE(a.color, color) - colorDeltaE(b.color, color) || a.slot - b.slot)[0]
}

/**
 * Why project.add_filament refuses `patch` on a project with filaments `all`, if it does: a color the project already
 * has in that material. A new filament with no type given takes `defaultType`; with no color given it takes the default
 * color for its number and is never refused here.
 */
export function addFilamentRefusal(all: readonly NumberedFilament[], patch: { type?: string | undefined; color?: string | undefined }, defaultType: string): string | undefined {
  if (patch.color === undefined) return undefined
  const color = filamentColor(patch.color)
  const same = sameFilament(all, patch.type !== undefined ? filamentType(patch.type) : defaultType, color)
  return same ? `Filament ${same.slot} is already ${same.type} ${same.color}, close to ${color}: paint or print with filament ${same.slot}. Nothing was added.` : undefined
}

/** Why project.set_filament refuses `patch` on filament `cur`, if it does: a material type other than its own. */
export function setFilamentRefusal(cur: NumberedFilament, patch: { type?: string | undefined }): string | undefined {
  if (patch.type === undefined) return undefined
  const type = filamentType(patch.type)
  return baseMaterial(type) !== baseMaterial(cur.type) ? `Filament ${cur.slot} stays ${cur.type}: a filament's material is not changed. For ${type}, add a filament with project.add_filament. Nothing changed.` : undefined
}
