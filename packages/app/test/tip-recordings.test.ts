// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The real-app clips in tips (src/demos/rec): each control that teaches where to click points at its clip, each clip
// is an animated WebP 320 px wide at the size its tip reserves, with a still poster, in a dark and a light take, and
// the six stay small enough to fetch on a first hover.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordedDemo } from '@slicerx/ui'
import { describe, expect, it } from 'vitest'
import { DEMOS } from '../src/lib/demos'
import { TIPS } from '../src/lib/tips'

const IDS = ['rec-paint', 'rec-arrange', 'rec-color-by', 'rec-layer-add', 'rec-toolhead', 'rec-follow'] as const
const recorded = (id: string) => DEMOS[id] as RecordedDemo
// under test vite hands out /src/demos/rec/<name>.webp; vitest runs in packages/app, where the file is
const file = (href: string) => join(process.cwd(), 'src', 'demos', 'rec', href.split('/').pop()!)

/** A WebP's canvas size and whether it is animated, from its RIFF header (VP8X chunk). */
function webp(path: string): { width: number; height: number; animated: boolean } {
  const b = readFileSync(path)
  expect(b.toString('ascii', 0, 4)).toBe('RIFF')
  expect(b.toString('ascii', 8, 12)).toBe('WEBP')
  const chunk = b.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, animated: (b[20]! & 0x02) !== 0 }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false }
  }
  // lossy VP8: the frame header's size fields
  return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false }
}

describe('real-app clips in tips', () => {
  it('points each where-to-click control at its clip', () => {
    expect(TIPS['tool.paint'].demo).toBe('rec-paint')
    expect(TIPS['plate.arrange'].demo).toBe('rec-arrange')
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    expect(src('../src/workspaces/view-menus.tsx')).toMatch(/title: 'Toolpath colors'[^}]*demo: 'rec-color-by'/)
    expect(src('../src/workspaces/preview/layer-track.tsx')).toMatch(/title: 'Add at this layer'[^}]*demo: 'rec-layer-add'/)
    expect(src('../src/workspaces/preview/preview-hud.tsx')).toMatch(/title: 'Show toolhead'[^}]*demo: 'rec-toolhead'/)
    expect(src('../src/workspaces/preview/preview-hud.tsx')).toMatch(/title: 'Follow the nozzle'[^}]*demo: 'rec-follow'/)
  })

  it('has an animated clip and a still poster per theme, 320 px wide at the size the tip reserves', () => {
    for (const id of IDS) {
      const d = recorded(id)
      expect(d.stage, id).toBeUndefined()
      expect(d.width, id).toBe(320)
      for (const take of [{ src: d.src, poster: d.poster }, d.light!]) {
        const clip = webp(file(take.src))
        expect(clip, `${id} ${take.src}`).toEqual({ width: 320, height: d.height, animated: true })
        const poster = webp(file(take.poster))
        expect({ width: poster.width, height: poster.height, animated: poster.animated }, `${id} ${take.poster}`).toEqual({ width: 320, height: d.height, animated: false })
      }
      expect(d.label.length, id).toBeGreaterThan(20)
    }
  })

  it('keeps each take within 150 KB, and all six clips under 900 KB', () => {
    const kb = (href: string) => statSync(file(href)).size / 1024
    let total = 0
    for (const id of IDS) {
      const d = recorded(id)
      expect(kb(d.src), id).toBeLessThanOrEqual(150)
      expect(kb(d.light!.src), id).toBeLessThanOrEqual(150)
      const clips = kb(d.src) + kb(d.light!.src)
      // a poster is one still: it shows at once on a first hover
      expect(kb(d.poster), id).toBeLessThanOrEqual(24)
      expect(kb(d.light!.poster), id).toBeLessThanOrEqual(24)
      total += clips
    }
    expect(total).toBeLessThanOrEqual(900)
  })
})
