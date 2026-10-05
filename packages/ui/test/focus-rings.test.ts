// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function cssFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((n) => {
    const p = `${dir}/${n}`
    if (n === 'node_modules' || n === 'dist') return []
    return statSync(join(root, p)).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : []
  })
}

type Rule = { file: string; selector: string; body: string }
function rules(file: string): Rule[] {
  const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1]!.trim(), body: m[2]! }))
}
const files = [...cssFiles('packages/ui/src'), ...cssFiles('packages/app/src'), 'packages/pilot/ui/pilot.css']
const all = files.flatMap(rules)

// inputs whose wrapper draws the ring, so the input itself shows none
const WRAPPED = ['.sx-scrub-input', '.tf-input', 'input.bare', '.sx-palette-input', '.sx-pilot .in-row input']

describe('focus rings', () => {
  it('tokens.css defines the ring once', () => {
    const t = read('packages/ui/src/tokens.css')
    for (const k of ['--focus-ring:', '--focus-offset:', '--focus-offset-inset:', '--focus-field:']) expect(t).toContain(k)
  })

  it('the global :focus-visible rule and the core controls use the token', () => {
    const ui = rules('packages/ui/src/styles.css')
    const global = ui.find((r) => r.selector === ':focus-visible')
    expect(global?.body ?? '').toContain('var(--focus-ring)')
    expect(global?.body ?? '').toContain('var(--focus-offset)')
    for (const sel of ['.sx-input:focus-visible', '.sx-menu-item:focus-visible', '.sx-seg > button:focus-visible', '.sx-scrub:focus-within'])
      expect(ui.some((r) => r.selector.includes(sel)), sel).toBe(true)
  })

  it('no rule outside the token draws a raw outline on focus', () => {
    const bad = all.filter((r) => /:focus/.test(r.selector) && /outline\s*:\s*\d+px/.test(r.body))
    expect(bad.map((r) => `${r.file}: ${r.selector}`)).toEqual([])
  })

  it('a ring never shows on a mouse click: no :focus rule draws one', () => {
    const bad = all.filter((r) => /:focus(?![-\w])/.test(r.selector) && (/box-shadow|border-color/.test(r.body) || /outline\s*:\s*[^;]*\d+px/.test(r.body)))
    expect(bad.map((r) => `${r.file}: ${r.selector}`)).toEqual([])
  })

  it('outline: none always has a focus-visible replacement', () => {
    const bad = all.filter((r) => /outline\s*:\s*(none|0)\b/.test(r.body)).filter((r) => {
      const base = r.selector.split(',').map((s) => s.replace(/:focus(-visible|-within)?/g, '').trim())
      if (base.every((b) => WRAPPED.includes(b))) return false
      if (/:focus-visible/.test(r.selector) && /box-shadow|border-color/.test(r.body)) return false
      return !all.some((o) => o.file === r.file && o !== r && base.some((b) => o.selector.includes(`${b}:focus-visible`)))
    })
    expect(bad.map((r) => `${r.file}: ${r.selector}`)).toEqual([])
  })
})
