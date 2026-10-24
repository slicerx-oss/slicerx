// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's keep-out areas (its excluded corner, the A1's nozzle wrap check corner) read on the bare bed of every
// bundled theme, dark and light: 3:1 for the hatch stripes at full strength and for the outline (WCAG 2.2, non-text
// contrast), measured against the bed's faint fill over the top and the bottom of the backdrop.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK } from '../src/look'
import { SCENE, contrastRatio, mixHex } from '../src/palette'
import { BED_FILL, KEEP_OUT_STRIPE, KEEP_OUT_WASH, keepOutInk } from '../src/stage'

const MIN = 3

interface Studio { name: string; dark: boolean; bgTop: string; bgBottom: string; floorGrid: string; edgeDark: string }

/** The Subban studios take their backdrop from the look presets; every other bundled theme keeps its own scene block. */
function studios(): Studio[] {
  const dir = new URL('../../themes/', import.meta.url)
  const out: Studio[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'schema.json') continue
    const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { id: string; isDark: boolean; scene: { top: string; bottom: string; grid: string; edge?: string } }
    const preset = t.id.startsWith('subban') ? (t.isDark ? DARK_PRECISION_LOOK : LIGHT_STUDIO_LOOK).backdrop : null
    out.push({ name: t.id, dark: t.isDark, bgTop: preset?.top ?? t.scene.top, bgBottom: preset?.bottom ?? t.scene.bottom, floorGrid: t.scene.grid, edgeDark: t.scene.edge ?? SCENE.edgeDark })
  }
  return out
}

describe('keep-out area contrast', () => {
  const all = studios()

  it('covers both schemes of the bundled themes', () => {
    expect(all.some((s) => s.name === 'subban-dark')).toBe(true)
    expect(all.some((s) => s.name === 'subban-light')).toBe(true)
    expect(all.length).toBeGreaterThanOrEqual(20)
  })

  it('draws in the grid color on a dark studio and the edge color on a light one', () => {
    for (const s of all) expect(keepOutInk(s), s.name).toBe(s.dark ? s.floorGrid : s.edgeDark)
  })

  it('keeps 3:1 against the bare bed of every bundled theme, on the stripes and the outline', () => {
    const fails: string[] = []
    for (const s of all) {
      const ink = keepOutInk(s)
      for (const [where, bg] of [['top', s.bgTop], ['bottom', s.bgBottom]] as const) {
        const bed = mixHex(bg, s.floorGrid, BED_FILL)
        const stripe = contrastRatio(mixHex(bed, ink, KEEP_OUT_STRIPE), bed)
        const edge = contrastRatio(ink, bed)
        if (stripe < MIN) fails.push(`${s.name} ${where} ${bed}: stripe ${stripe.toFixed(2)}`)
        if (edge < MIN) fails.push(`${s.name} ${where} ${bed}: outline ${edge.toFixed(2)}`)
      }
    }
    expect(fails).toEqual([])
  })

  it('keeps the wash between the stripes quiet', () => {
    expect(KEEP_OUT_WASH).toBeLessThanOrEqual(0.1)
    expect(KEEP_OUT_STRIPE).toBeGreaterThan(KEEP_OUT_WASH)
  })
})
