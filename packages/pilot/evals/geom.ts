// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node only: kept out of harness.ts so the browser dev harness can import that.
import { existsSync } from 'node:fs'
import { createGeomCli, createGeomWasm } from '../src/node/index'
import type { ToolHost } from '../src/tool'

export interface GeomChoice {
  kind: 'wasm' | 'native'
  path: string
}

/**
 * Which engine the tests use, chosen by name and never by file age (the native binary and the wasm
 * refuse some requests in different words, so "whichever was built last" made results depend on build order).
 *
 * - Default: the web build, packages/geom/wasm/pkg/sx_geom_wasm.wasm (or SX_GEOM_WASM). It is what CI and the app use.
 * - SX_TEST_GEOM_ENGINE=native: the native sx-geom, on purpose. SLICERX_SX_GEOM_BIN names one; otherwise
 *   target/release/sx-geom, then target/debug/sx-geom (cargo build -p sx-geom). Not built is an error.
 *
 * Returns undefined when the default wasm is not built, so tests that need geometry skip.
 */
export function chooseGeomEngine(opts: { root: string; wasm: string; env: Record<string, string | undefined> }): GeomChoice | undefined {
  const { root, wasm, env } = opts
  const engine = env['SX_TEST_GEOM_ENGINE'] ?? 'wasm'
  if (engine !== 'wasm' && engine !== 'native') throw new Error(`SX_TEST_GEOM_ENGINE must be wasm or native, got "${engine}"`)
  if (engine === 'wasm') return existsSync(wasm) ? { kind: 'wasm', path: wasm } : undefined
  const path = [env['SLICERX_SX_GEOM_BIN'], `${root}release/sx-geom`, `${root}debug/sx-geom`].find((p): p is string => !!p && existsSync(p))
  if (!path) throw new Error(`SX_TEST_GEOM_ENGINE=native but there is no sx-geom under ${root}: build it with cargo build -p sx-geom, or name one in SLICERX_SX_GEOM_BIN`)
  return { kind: 'native', path }
}

/** The geometry engine for scenarios that need it, through `hosts`. See chooseGeomEngine for how it is chosen. */
export function evalGeom(): ToolHost['geom'] {
  const root = new URL('../../../target/', import.meta.url).pathname
  const wasm = process.env['SX_GEOM_WASM'] ?? new URL('../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url).pathname
  const choice = chooseGeomEngine({ root, wasm, env: process.env })
  // Tests that need geometry skip without it, except on CI, whose web job builds the module first.
  if (!choice && process.env['CI'] === 'true') throw new Error(`CI=true but there is no geometry engine at ${wasm}: build it with packages/geom/wasm/scripts/build.sh`)
  if (!choice) return undefined
  return choice.kind === 'wasm' ? createGeomWasm({ wasm: choice.path }) : createGeomCli({ binary: choice.path })
}
