// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node only: kept out of harness.ts so the browser dev harness can import that.
import { existsSync, statSync } from 'node:fs'
import { createGeomCli, createGeomWasm } from '../src/node/index'
import type { ToolHost } from '../src/tool'

/**
 * The sx-geom command from the workspace build (cargo build -p sx-geom) or its web build
 * (packages/geom/wasm/pkg/sx_geom_wasm.wasm, or SX_GEOM_WASM), whichever was built last, so an old
 * build of one never hides a newer build of the other. Scenarios that need geometry use it through
 * `hosts`.
 */
export function evalGeom(): ToolHost['geom'] {
  const root = new URL('../../../target/', import.meta.url).pathname
  const wasm = process.env['SX_GEOM_WASM'] ?? new URL('../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url).pathname
  const builds = [
    ...[`${root}release/sx-geom`, `${root}debug/sx-geom`].map((path) => ({ path, make: () => createGeomCli({ binary: path }) })),
    { path: wasm, make: () => createGeomWasm({ wasm }) },
  ].filter((b) => existsSync(b.path))
  const newest = builds.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0]
  return newest?.make()
}
