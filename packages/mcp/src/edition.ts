// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's name for a server run on its own: the brand.name of the resolved edition config SLICERX_CONFIG names (the
// file cloud slicing, locked projects and local AI read too). Inside an app, the app sets the name itself.
import { existsSync, readFileSync } from 'node:fs'

/** The edition's brand.name, or undefined without a config that names one. */
export function editionNameFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const path = env['SLICERX_CONFIG']
  if (!path || !existsSync(path)) return undefined
  const c = JSON.parse(readFileSync(path, 'utf8')) as { brand?: { name?: unknown } }
  const name = typeof c.brand?.name === 'string' ? c.brand.name.trim() : ''
  return name || undefined
}
