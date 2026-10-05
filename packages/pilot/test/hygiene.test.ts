// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Repository hygiene for packages/pilot: no API keys, no dashes as
// punctuation, SPDX headers on every source file.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', 'target', '.turbo', 'dist'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else out.push(p)
  }
  return out
}

const all = files(root)
const text = all.filter((f) => /\.(ts|tsx|rs|json|jsonl|md|toml|css|yaml|yml|txt)$/.test(f))

describe('hygiene', () => {
  it('nothing under packages/pilot looks like an API key', () => {
    const shapes = [/sk-[A-Za-z0-9]{20,}/, /sk-proj-[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /Bearer\s+[A-Za-z0-9._-]{30,}/, /OPENAI_API_KEY\s*=\s*['"]?[A-Za-z0-9-]{10,}/]
    const hits = text.flatMap((f) => {
      const body = readFileSync(f, 'utf8')
      return shapes.filter((re) => re.test(body)).map((re) => `${relative(root, f)} matches ${re.source}`)
    })
    expect(hits).toEqual([])
  })

  it('has no em or en dashes', () => {
    const bad = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
    const hits = text.filter((f) => bad.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(hits).toEqual([])
  })

  it('every source file starts with the SPDX header', () => {
    const src = all.filter((f) => /\.(ts|tsx|rs|css)$/.test(f))
    // REUSE-IgnoreStart
    const missing = src.filter((f) => !readFileSync(f, 'utf8').slice(0, 200).includes('SPDX-License-Identifier: Apache-2.0')).map((f) => relative(root, f))
    // REUSE-IgnoreEnd
    expect(missing).toEqual([])
  })
})
