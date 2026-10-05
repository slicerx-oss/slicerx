// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICON_COUNT, ICON_GROUPS, ICON_PATHS, NOCTURNE, NOCTURNE_VARS } from '../src/index'

const here = resolve(import.meta.dirname)
const tokensCss = readFileSync(resolve(here, '../src/tokens.css'), 'utf8')
const stylesCss = readFileSync(resolve(here, '../src/styles.css'), 'utf8')

const norm = (v: string) => v.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ')

function cssValue(css: string, name: string): string | undefined {
  const m = css.match(new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`))
  return m?.[1]?.trim()
}

describe('tokens', () => {
  it('NOCTURNE hex values match tokens.css', () => {
    for (const [key, hex] of Object.entries(NOCTURNE)) {
      const name = NOCTURNE_VARS[key as keyof typeof NOCTURNE]
      expect(cssValue(tokensCss, name), name).toBe(hex)
    }
  })

  it('styles.css writes no hex colors', () => {
    // The select chevron is an inline SVG data URI; its stroke is the --dim hex and is allowed.
    const body = stylesCss.replace(/url\("data:[^"]*"\)/g, '')
    expect(body.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([])
  })

  it('has no em or en dashes', () => {
    for (const text of [tokensCss, stylesCss]) expect(text).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']'))
  })
})

/** Absolute points of an SVG path (end points and control points; arc radii are not points). */
function pathPoints(d: string): [number, number][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
  const pts: [number, number][] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  let i = 0
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i] as string)) cmd = tokens[i++] as string
    const lower = cmd.toLowerCase()
    const rel = cmd === lower
    if (lower === 'z') {
      x = sx
      y = sy
      continue
    }
    const n = arity[lower]
    if (n === undefined) throw new Error('unknown path command ' + cmd)
    const a = tokens.slice(i, i + n).map(Number)
    i += n
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    if (lower === 'h') x = (rel ? x : 0) + (a[0] as number)
    else if (lower === 'v') y = (rel ? y : 0) + (a[0] as number)
    else if (lower === 'a') {
      x = ox + (a[5] as number)
      y = oy + (a[6] as number)
    } else {
      for (let k = 0; k < n - 2; k += 2) pts.push([ox + (a[k] as number), oy + (a[k + 1] as number)])
      x = ox + (a[n - 2] as number)
      y = oy + (a[n - 1] as number)
    }
    pts.push([x, y])
    if (lower === 'm') {
      sx = x
      sy = y
      cmd = rel ? 'l' : 'L'
    }
  }
  return pts
}

describe('icons', () => {
  it('ships the base icons plus the added set', () => {
    expect(ICON_COUNT).toBeGreaterThanOrEqual(178)
    expect(ICON_COUNT).toBe(Object.keys(ICON_PATHS).length)
  })

  it('groups cover every icon once', () => {
    const grouped = Object.values(ICON_GROUPS).flat()
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped.sort()).toEqual(Object.keys(ICON_PATHS).sort())
  })

  it('keeps the 67 base icons unchanged and first', async () => {
    const { BASE_ICONS } = await import('../icons/base.mjs')
    const SX_ICONS = BASE_ICONS
    expect(Object.keys(SX_ICONS)).toHaveLength(67)
    expect(Object.keys(ICON_PATHS).slice(0, 67)).toEqual(Object.keys(SX_ICONS))
    for (const [name, markup] of Object.entries(SX_ICONS)) expect(ICON_PATHS[name as keyof typeof ICON_PATHS], name).toBe(markup)
  })

  it('draws every icon with plain shapes inside the 24px grid', () => {
    const allowed = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'ellipse'])
    for (const [name, markup] of Object.entries(ICON_PATHS)) {
      const tags = [...markup.matchAll(/<\s*([a-zA-Z]+)/g)].map((m) => m[1] as string)
      expect(tags.length, name).toBeGreaterThan(0)
      for (const tag of tags) expect(allowed.has(tag), `${name} uses <${tag}>`).toBe(true)
      for (const [, fill] of markup.matchAll(/fill="([^"]*)"/g)) expect(fill, name).toBe('currentColor')
      expect(markup, name).not.toMatch(/<text|<\/|style=|href/)

      const inGrid = (v: number, what: string) => expect(v >= 0 && v <= 24, `${name}: ${what} = ${v}`).toBe(true)
      for (const el of markup.matchAll(/<([a-z]+)\s([^>]*)\/>/g)) {
        const tag = el[1] as string
        const attrs = Object.fromEntries([...(el[2] as string).matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
        const num = (k: string) => Number(attrs[k] ?? 0)
        if (tag === 'path') for (const [px, py] of pathPoints(attrs.d ?? '')) (inGrid(px, 'x'), inGrid(py, 'y'))
        if (tag === 'circle') for (const v of [num('cx') - num('r'), num('cx') + num('r'), num('cy') - num('r'), num('cy') + num('r')]) inGrid(v, 'circle')
        if (tag === 'ellipse') for (const v of [num('cx') - num('rx'), num('cx') + num('rx'), num('cy') - num('ry'), num('cy') + num('ry')]) inGrid(v, 'ellipse')
        if (tag === 'rect') for (const v of [num('x'), num('y'), num('x') + num('width'), num('y') + num('height')]) inGrid(v, 'rect')
        if (tag === 'line') for (const k of ['x1', 'y1', 'x2', 'y2']) inGrid(num(k), k)
        if (tag === 'polyline') for (const v of (attrs.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number)) inGrid(v, 'points')
      }
    }
  })
})
