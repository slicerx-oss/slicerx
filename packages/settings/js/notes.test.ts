// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every setting a user can see has a short, plain note for its tooltip.
import { describe, expect, it } from 'vitest'
import { SETTING_NOTES, SETTINGS, settingDef } from './index'

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
})
