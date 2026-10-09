// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar speaks plainly: no triangle counts ("tris") outside Developer mode, and no "Filament 1" for a
// part's filament. The engine words live in tooltips and in Developer mode.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panes = readFileSync(resolve(import.meta.dirname, '../src/workspaces/prepare/prepare-panes.tsx'), 'utf8')
// The object rows, with their part filaments and triangle counts.
const rows = readFileSync(resolve(import.meta.dirname, '../src/workspaces/prepare/object-row.tsx'), 'utf8')

describe('Slice sidebar words', () => {
  it('shows no "tris" and names part filaments by slot, type and color', () => {
    for (const src of [panes, rows]) {
      expect(src).not.toMatch(/\btris\b/)
      expect(src).not.toMatch(/>\s*Filament \{k \+ 1\}/)
    }
    expect(rows).toMatch(/slotLabel\(s\)/)
  })

  it('shows the triangle count inline only in Developer mode', () => {
    expect(rows).toMatch(/\{developer \? `, \$\{triangles\(p\.handle\.triangles\)\}` : null\}/)
  })

  it('puts the threads in the time tooltip, not a note under the button', () => {
    expect(panes).not.toMatch(/worker threads/)
    expect(panes).toMatch(/slicedIn\(done\.result\.wallMs, host\.capabilities\.threads\)/)
  })

  it('keeps the segment count and the engine out of the Sliced plate line, apart from its tooltip and Developer mode', () => {
    const preview = readFileSync(resolve(import.meta.dirname, '../src/workspaces/preview/preview-panes.tsx'), 'utf8')
    expect(preview).toMatch(/\{developer \? <p className="app-note">\{engineLine\}\.<\/p> : null\}/)
    expect(preview).toMatch(/tipAttrs\(\{ title: engineLine \}\)/)
    expect(preview.match(/toolpath segments/g)).toHaveLength(1)
  })
})
