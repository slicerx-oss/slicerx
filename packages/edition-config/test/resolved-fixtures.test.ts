// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The resolved configs in fixtures/ are what the Rust crate (rust/src/lib.rs, sx-edition-config) reads in its tests,
// with unknown fields refused. They must be exactly what this package resolves today, so a field added to the schema
// here fails the Rust tests until the Rust config knows it (features.cad once reached sx-cloud that way).
// SX_FIXTURES_WRITE=1 writes them afresh.
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadEditionConfig } from '../src/node.ts'

const at = (name: string) => new URL(`../fixtures/${name}`, import.meta.url)

describe('the resolved fixtures the Rust crate reads', () => {
  for (const [name, file] of [
    ['neutral.resolved.json', undefined],
    ['fork-harbor.resolved.json', 'fork-harbor.json'],
  ] as const) {
    it(`${name} is what this package resolves now`, async () => {
      const config = await loadEditionConfig({ env: {}, cwd: new URL('../fixtures/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...(file ? { file } : {}) })
      const text = `${JSON.stringify(config, null, 2)}\n`
      if (process.env['SX_FIXTURES_WRITE'] === '1') writeFileSync(at(name), text)
      expect(JSON.parse(readFileSync(at(name), 'utf8'))).toEqual(JSON.parse(text))
    })
  }
})
