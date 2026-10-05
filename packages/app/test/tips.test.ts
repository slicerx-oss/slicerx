// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEY_ACTIONS } from '@slicerx/ui'
import { loadSettingTips, resolveTip } from '../src/lib/tip-host'
import { OPTION_TIPS, TIPS, type TipEntry } from '../src/lib/tips'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('feature tooltips', () => {
  it('keeps each body to one short sentence that starts with a verb', () => {
    for (const [id, t] of Object.entries(TIPS) as [string, TipEntry][]) {
      expect(t.body.length, id).toBeLessThanOrEqual(90)
      expect(t.body, id).toMatch(/^[A-Z]/)
      expect(t.body.endsWith('.'), id).toBe(true)
      expect(t.title, id).not.toMatch(/[.!]$/)
      if (t.action) expect(KEY_ACTIONS as readonly string[], id).toContain(t.key)
    }
  })

  it('has the aegis option tip', () => {
    expect(OPTION_TIPS['wall_generator.aegis']?.body).toBe('aegis varies wall width to fit the part, so thin features print solid and walls stay even, with fewer width changes than Arachne on the shapes we measured.')
  })

  it('shows the key from the active keymap', () => {
    const el = document.createElement('button')
    el.setAttribute('data-tip', 'tool.move')
    expect(resolveTip(el, { 'tool.move': 'Shift+M' })?.keys).toEqual([expect.stringMatching(/M$/)])
    expect(resolveTip(el, { 'tool.move': null })?.keys).toBeUndefined()
  })

  it('shows a setting tip once the settings data has loaded', async () => {
    const el = document.createElement('div')
    el.setAttribute('data-tip', 'setting:layer_height')
    await loadSettingTips()
    const tip = resolveTip(el, {})
    expect(tip?.title).toBeTruthy()
    expect(tip?.body).toBeTruthy()
  })

  it('reads one-off text from the element', () => {
    const el = document.createElement('span')
    el.setAttribute('data-tip-title', 'Warm')
    el.setAttribute('data-tip-body', 'Too hot.')
    expect(resolveTip(el, {})).toEqual({ title: 'Warm', body: 'Too hot.' })
    expect(resolveTip(document.createElement('span'), {})).toBeNull()
  })

  it('leaves no title attribute on an element in the app or the UI kit', () => {
    const roots = [join(__dirname, '../src'), join(__dirname, '../../ui/src')]
    const hits: string[] = []
    for (const f of roots.flatMap(files)) {
      const src = readFileSync(f, 'utf8')
      // A title prop on a lowercase tag or a Button is a native tooltip. Other components (Dialog, Block, Section) take a title as content.
      for (const m of src.matchAll(/\stitle=/g)) {
        const tag = /<([A-Za-z][A-Za-z0-9]*)\b[^<]*$/.exec(src.slice(0, m.index))?.[1]
        if (tag && (tag[0] === tag[0]!.toLowerCase() || tag === 'Button' || tag === 'LinkButton')) hits.push(`${f}: <${tag} title=`)
      }
    }
    expect(hits).toEqual([])
  })
})
