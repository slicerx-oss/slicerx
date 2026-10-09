// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate type is the plate's own, a project's or the printer's default (plate/bed-type.ts). No other source names one,
// so the printer card and the plate picker cannot show a plate the slice does not use.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(import.meta.dirname, '../src')
// The one place the plate types and their names live, and the 3MF writer, which keeps Orca's file names for them
// next to its plate_N.json names (importing bed-type there splits it out of the startup chunk, 0.2 KB more).
const ALLOWED = new Set(['plate/bed-type.ts', 'export/threemf.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('plate types', () => {
  it('no source outside plate/bed-type.ts and the 3MF writer hard-codes a PEI plate', () => {
    const hits = files(src)
      .filter((path) => !ALLOWED.has(relative(src, path)))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(src, path)}:${i + 1}` }))
          .filter(({ line }) => /\bPEI\b/.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      )
    expect(hits).toEqual([])
  })
})
