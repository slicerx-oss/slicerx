// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { defaultConfig as full, SETTINGS } from './schema'
import { defaultConfig as small, sectionOf } from './defaults'

describe('defaults entry point', () => {
  it('gives the same config as the full schema, for every section', () => {
    expect(small()).toEqual(full())
    for (const s of ['process', 'filament', 'printer'] as const) expect(small(s)).toEqual(full(s))
  })

  it('is current: regenerate with `pnpm gen:defaults` after the schema changes', () => {
    expect(Object.keys(small()).sort()).toEqual(SETTINGS.map((d) => d.key).sort())
    for (const d of SETTINGS) expect(sectionOf(d.key), d.key).toBe(d.section)
  })

  it('hands out copies, so one caller cannot change the defaults of another', () => {
    const a = small() as Record<string, unknown>
    const b = small() as Record<string, unknown>
    const key = Object.keys(a).find((k) => Array.isArray(a[k]))!
    ;(a[key] as unknown[]).push('x')
    expect(b[key]).toEqual(full()[key])
  })

  it('does not bring the schema in: the module imports only defaults.json', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./defaults.ts', import.meta.url), 'utf8')
    const imports = src.split('\n').filter((l) => l.startsWith('import'))
    expect(imports.join('\n')).not.toMatch(/schema/)
  })
})
