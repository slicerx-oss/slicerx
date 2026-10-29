// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync } from 'node:fs'

/**
 * Whether a native binary a test needs (sx, sx-geom, sx-link, sx-relay) is built at `path`. Without one the test
 * skips, except in CI's rust tests crates part, which builds them first and sets SLICERX_TEST_REQUIRE_SX=1: there a
 * missing one fails the file instead. `build` says how to make it.
 */
export function binBuilt(path: string | undefined, build: string): boolean {
  if (path && existsSync(path)) return true
  if (process.env['SLICERX_TEST_REQUIRE_SX'] === '1') {
    throw new Error(`SLICERX_TEST_REQUIRE_SX=1 but ${path ? `there is nothing at ${path}` : 'no binary is named'}: ${build}`)
  }
  return false
}

export const SX_BUILD = 'build sx (cargo build -p sx-cli) and name it in SLICERX_TEST_SX_BIN'
export const GEOM_BUILD = 'build sx-geom (cargo build -p sx-geom) and name it in SLICERX_SX_GEOM_BIN'
