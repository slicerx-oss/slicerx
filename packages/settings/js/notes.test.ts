// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every setting a user can see has a short, plain note for its tooltip.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PRODUCT_NAME, setProductName } from '@slicerx/contracts/brand'
import { SETTING_NOTES, SETTINGS, clearSettingText, registerSettingText, settingDef } from './index'

const VISIBLE = new Set(['simple', 'advanced', 'expert'])
const MAX = 240
const DASHES = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']')

/** Sentences, not counting the points inside numbers such as 0.4. */
function sentences(text: string): string[] {
  return text
    .replace(/(\d)\.(\d)/g, '$1#$2')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
}

describe('setting notes', () => {
  const visible = SETTINGS.filter((d) => VISIBLE.has(d.mode))

  it('cover every user-visible setting', () => {
    const missing = visible.filter((d) => !d.note?.trim()).map((d) => d.key)
    expect(missing).toEqual([])
    expect(visible.length).toBeGreaterThan(600)
  })

  it('name only keys the schema has', () => {
    expect(Object.keys(SETTING_NOTES).filter((k) => !settingDef(k))).toEqual([])
  })

  it('are one or two sentences under the length cap', () => {
    const bad = Object.entries(SETTING_NOTES).filter(([, n]) => n.length > MAX || sentences(n).length > 2 || !/[.]$/.test(n))
    expect(bad).toEqual([])
  })

  it('use no dashes as punctuation and no British spellings', () => {
    const bad = Object.entries(SETTING_NOTES).filter(([, n]) => DASHES.test(n) || / -- /.test(n) || /\b(colour|licence|behaviour|centre|grey|artefact|metre)/i.test(n))
    expect(bad).toEqual([])
  })

  it('keep feature names lowercase', () => {
    const bad = Object.entries(SETTING_NOTES).filter(([, n]) => /\b(Aegis|Sleipnir|Atlas|Mimir|Norn|Heimdall)\b/.test(n))
    expect(bad).toEqual([])
  })

  it('reach the definitions', () => {
    expect(settingDef('wall_loops')?.note).toMatch(/loops/)
  })

  // A note that points to another setting writes its label in double quotes, exactly as the schema has it.
  it('quote only labels the schema has', () => {
    const labels = new Set(SETTINGS.map((d) => d.label))
    const bad = Object.entries(SETTING_NOTES)
      .flatMap(([k, n]) => [...n.matchAll(/"([^"]+)"/g)].map((m) => ({ k, q: m[1]! })))
      .filter((x) => !labels.has(x.q))
      .map((x) => `${x.k}: "${x.q}"`)
    expect(bad).toEqual([])
  })

  it('do not name a label that a setting no longer has', () => {
    const renamed = JSON.parse(readFileSync(new URL('../fixtures/renamed-labels.json', import.meta.url), 'utf8')) as { labels: Record<string, string> }
    const current = new Set(SETTINGS.map((d) => d.label.toLowerCase()))
    const stale = Object.entries(renamed.labels).filter(([, old]) => !current.has(old.toLowerCase()))
    const names = (text: string, phrase: string): boolean => {
      const t = text.toLowerCase()
      const p = phrase.toLowerCase()
      for (let at = t.indexOf(p); at >= 0; at = t.indexOf(p, at + 1)) {
        const before = t.charAt(at - 1)
        const after = t.charAt(at + p.length)
        if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return true
      }
      return false
    }
    const bad = Object.entries(SETTING_NOTES).flatMap(([k, n]) =>
      stale.filter(([, old]) => names(n, old)).map(([rk, old]) => `${k} names "${old}" (now ${settingDef(rk)?.label})`),
    )
    expect(bad).toEqual([])
  })
})

// White label: notes.json says SlicerX, and an edition's notes say its own name.
describe('setting notes in an edition', () => {
  afterEach(() => {
    setProductName(DEFAULT_PRODUCT_NAME)
    clearSettingText()
  })

  it('name the edition, including after a text overlay', () => {
    const key = 'flush_into_infill'
    expect(settingDef(key)?.note).toMatch(/\bSlicerX\b/)
    setProductName('Acme Slicer')
    expect(SETTING_NOTES[key]).toMatch(/\bAcme Slicer\b/)
    expect(SETTING_NOTES[key]).not.toMatch(/SlicerX/)
    expect(settingDef(key)?.note).toBe(SETTING_NOTES[key])
    registerSettingText({ [key]: { label: 'Flush into infill' } })
    expect(settingDef(key)?.label).toBe('Flush into infill')
    expect(settingDef(key)?.note).toMatch(/\bAcme Slicer\b/)
    // An overlay's own note is used as written.
    registerSettingText({ [key]: { note: 'Own words.' } })
    expect(settingDef(key)?.note).toBe('Own words.')
  })
})
