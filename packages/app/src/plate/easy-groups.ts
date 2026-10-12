// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The keys each Easy control decides together. One press of Supports can write several keys; in Simple that is one
// setting of the object's own, so badges count a group once.
import type { EasySettings, SettingValue } from '@slicerx/contracts'
import { easyConfigFor, profileLayerToken } from '../adapters/config'
import { SETTINGS } from '../adapters/settings'
import { choicePatch, FIXED_HEIGHTS } from '../lib/layer-choice'
import { variesPerObject } from './plate-wide'

const same = (a: SettingValue | undefined, b: SettingValue | undefined) => JSON.stringify(a) === JSON.stringify(b)

/** Each setting by its key (the first of a key, as a search of SETTINGS finds it), looked up for every key of every config. */
let defs: Map<string, (typeof SETTINGS)[number]> | null = null
function defOf(key: string): (typeof SETTINGS)[number] | undefined {
  if (!defs) {
    defs = new Map()
    for (const d of SETTINGS) if (!defs.has(d.key)) defs.set(d.key, d)
  }
  return defs.get(key)
}

/** The keys an Easy control decides: those that differ between the configs its choices give. */
export function controlKeys(easy: EasySettings, patches: readonly Partial<EasySettings>[], controls: readonly string[]): string[] {
  const cfgs = patches.map((p) => easyConfigFor({ ...easy, ...p }, controls))
  const keys = new Set(cfgs.flatMap((c) => Object.keys(c)))
  return [...keys].filter((k) => {
    const def = defOf(k)
    return def !== undefined && variesPerObject(def) && cfgs.some((c) => !same(c[k], cfgs[0]?.[k]))
  })
}

export const LAYER_PATCHES = FIXED_HEIGHTS.map((h) => choicePatch(h))
export const SUPPORT_PATCHES = (['off', 'auto', 'painted'] as const).map((supports) => ({ supports }))
export const BRIM_PATCHES = [{ brim: true }, { brim: false }]
export const STRENGTH_PATCHES = [0, 25, 50, 75, 100].map((strength) => ({ strength }))

export interface EasyGroups {
  layer: string[]
  supports: string[]
  brim: string[]
  strength: string[]
}

/**
 * The last few answers, by the Easy values and the profile layer they were worked out for. Working one out resolves
 * the settings sixteen times, and every view that shows Simple's badges (the scope bar, each object row, the Simple
 * pane) asks again when `easy` changes, which an open does several times, each time a new object with the same values.
 */
const recent: { layer: object | null; easy: string; groups: EasyGroups }[] = []
const RECENT = 8

/** The keys of Simple's layer height, supports, brim and strength controls. The arrays are shared: do not change them. */
export function easyGroups(easy: EasySettings): EasyGroups {
  const layer = profileLayerToken()
  const key = JSON.stringify(easy)
  const hit = recent.find((r) => r.layer === layer && r.easy === key)
  if (hit) return hit.groups
  const groups = {
    layer: controlKeys(easy, LAYER_PATCHES, ['detail', 'varyLayerHeight']),
    supports: controlKeys(easy, SUPPORT_PATCHES, ['supports']),
    brim: controlKeys(easy, BRIM_PATCHES, ['brim']),
    strength: controlKeys(easy, STRENGTH_PATCHES, ['strength']),
  }
  recent.unshift({ layer, easy: key, groups })
  recent.length = Math.min(recent.length, RECENT)
  return groups
}

/** How many settings `keys` are, a group's keys counting once. */
export function countSettings(keys: Iterable<string>, groups: readonly (readonly string[])[] = []): number {
  const seen = new Set<string>()
  for (const k of keys) {
    const g = groups.findIndex((ks) => ks.includes(k))
    seen.add(g < 0 ? `k:${k}` : `g:${g}`)
  }
  return seen.size
}
