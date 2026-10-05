// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the fixture the Rust round-trip test writes: the TypeScript Easy interpreter must reproduce it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EasySettings, PrintConfig } from '@slicerx/contracts/settings'
import { applyEasy } from './easy'

const path = fileURLToPath(new URL('../../contracts/fixtures/settings-config.json', import.meta.url))

describe('contracts/fixtures/settings-config.json (written by sx-settings)', () => {
  const fx = JSON.parse(readFileSync(path, 'utf8')) as { base: PrintConfig; easy: EasySettings; result: Record<string, unknown> }
  it('has the merged base and the result', () => {
    expect(Object.keys(fx.base).length).toBeGreaterThan(50)
    expect(fx.result['layer_height']).toBe(0.2)
  })
  it('is reproduced by the TypeScript applyEasy', () => {
    const out = applyEasy(fx.easy, fx.base)
    for (const [k, v] of Object.entries(fx.result)) expect(out[k], k).toEqual(v)
    expect(Object.keys(out).sort()).toEqual(Object.keys(fx.result).sort())
  })
})
