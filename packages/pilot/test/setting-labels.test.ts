// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir names every setting with the words the settings dialogs show, so a plan's change list and the dialog never
// disagree about what a row is called. The only exceptions are the product's own feature names (design/NAMES.md),
// the catalog entries marked origin: slicerx, such as smart_layer, which mimir calls sleipnir.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { settingDef } from '@slicerx/settings'
import kbIndex from '../src/kb/generated/kb.json' with { type: 'json' }
import { createKnowledgeBase, type KbIndex } from '../src/kb/kb'

const catalog = parse(readFileSync(new URL('../../../knowledge/settings.yaml', import.meta.url), 'utf8')) as {
  settings: { key: string; origin?: string }[]
}
const feature = new Set(catalog.settings.filter((s) => s.origin === 'slicerx').map((s) => s.key))

const kb = createKnowledgeBase(kbIndex as KbIndex)
const named = kb.settings().filter((s) => !feature.has(s.key) && settingDef(s.key))

describe('setting labels in the knowledge base', () => {
  it('has a catalog of settings with a schema entry, and some product feature names', () => {
    expect(named.length).toBeGreaterThan(100)
    expect([...feature]).toContain('smart_layer')
  })

  it('labels every setting that is not a product feature as the settings schema does', () => {
    expect(named.filter((s) => s.label !== settingDef(s.key)!.label).map((s) => `${s.key}: ${s.label}`)).toEqual([])
  })

  it('looks a setting up by the same label', () => {
    for (const s of named) expect(kb.setting(s.key)?.label, s.key).toBe(settingDef(s.key)!.label)
  })

  it('keeps the catalog file itself on the schema label for process and filament settings', () => {
    const raw = (kbIndex as KbIndex).settings.filter((s) => !feature.has(s.key) && ['process', 'filament'].includes(settingDef(s.key)?.section ?? ''))
    expect(raw.length).toBeGreaterThan(80)
    expect(raw.filter((s) => s.label !== settingDef(s.key)!.label).map((s) => `${s.key}: ${s.label}`)).toEqual([])
  })

  it('keeps the feature names the product chose', () => {
    expect(kb.setting('smart_layer')?.label).toBe('sleipnir')
    expect(kb.setting('smart_layer_min_height')?.label).toBe('sleipnir thinnest layer')
  })
})
