// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's name and brand colors for a server run on its own: brand.name and brand.colors of the resolved edition config
// SLICERX_CONFIG names (the file cloud slicing, locked projects and local AI read too). Inside an app, the app sets them.
import { existsSync, readFileSync } from 'node:fs'

interface Brand {
  name?: unknown
  colors?: unknown
}

function brandFromEnv(env: NodeJS.ProcessEnv): Brand | undefined {
  const path = env['SLICERX_CONFIG']
  if (!path || !existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, 'utf8')) as { brand?: Brand }).brand
}

/** The edition's brand.name, or undefined without a config that names one. */
export function editionNameFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const brand = brandFromEnv(env)
  const name = typeof brand?.name === 'string' ? brand.name.trim() : ''
  return name || undefined
}

/** The edition's named brand colors (brand.colors, name to hex), or undefined without any. */
export function editionColorsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const colors = brandFromEnv(env)?.colors
  if (!colors || typeof colors !== 'object') return undefined
  const out = Object.fromEntries(Object.entries(colors).filter((e): e is [string, string] => /^[a-z]{1,16}$/.test(e[0]) && typeof e[1] === 'string' && /^#[0-9a-fA-F]{6}$/.test(e[1])))
  return Object.keys(out).length ? out : undefined
}
