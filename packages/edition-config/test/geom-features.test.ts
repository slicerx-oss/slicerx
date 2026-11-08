// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GEOM_FEATURES } from '../src/index.ts'

const cargoToml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'geom', 'Cargo.toml'), 'utf8')

/** The lines of the engine's [features] table: from its header to the next table. */
function featuresTable(): string {
  const lines = cargoToml.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === '[features]')
  if (start < 0) throw new Error('packages/geom/Cargo.toml has no [features] table')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('['))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** The quoted names in the table's `default = [ ... ]` list (it may span lines). */
function defaultFeatures(): string[] {
  const list = /^default\s*=\s*\[([^\]]*)\]/m.exec(featuresTable())?.[1]
  if (list === undefined) throw new Error('packages/geom/Cargo.toml has no default list in [features]')
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
}

/** Every feature the engine defines. */
function definedFeatures(): Set<string> {
  return new Set([...featuresTable().matchAll(/^([a-z0-9_-]+)\s*=/gm)].map((m) => m[1] as string))
}

/**
 * Default engine features an edition build does not pick from, with the reason. Empty today: every default feature
 * is something an edition can keep or leave out. A feature goes here only when a build must never name it.
 */
const LEFT_OUT_ON_PURPOSE: Record<string, string> = {}

describe('geometry engine features', () => {
  it('names every default feature of the engine, or says why it is left out', () => {
    expect(defaultFeatures().length).toBeGreaterThan(0)
    const missing = defaultFeatures().filter((f) => !(GEOM_FEATURES as readonly string[]).includes(f) && !(f in LEFT_OUT_ON_PURPOSE))
    expect(missing, 'add each to GEOM_FEATURES in src/build.ts, or to LEFT_OUT_ON_PURPOSE here with a reason').toEqual([])
  })

  it('lists only features the engine has', () => {
    const defined = definedFeatures()
    expect([...GEOM_FEATURES].filter((f) => !defined.has(f))).toEqual([])
    expect(Object.keys(LEFT_OUT_ON_PURPOSE).filter((f) => !defined.has(f))).toEqual([])
  })
})
