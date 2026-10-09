// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker loads no React module: a component file in its imports brings the dev server's React refresh
// preamble into the worker, which reads `window` and stops the worker before its first call.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '../src')

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = normalize(join(dirname(from), spec))
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext) && !base.endsWith('/') && (ext || /\.tsx?$/.test(base))) return base + ext
  return null
}

function graph(entry: string): string[] {
  const seen = new Set<string>()
  const walk = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const next = resolveImport(f, m[1]!)
      if (next) walk(next)
    }
  }
  walk(join(SRC, entry))
  return [...seen]
}

describe('the geometry worker', () => {
  it('imports no component file', () => {
    const files = graph('geom/geom-worker.ts')
    expect(files.length).toBeGreaterThan(3)
    expect(files.filter((f) => f.endsWith('.tsx')).map((f) => f.slice(SRC.length + 1))).toEqual([])
  })
})
