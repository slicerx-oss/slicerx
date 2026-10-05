// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { edgeGlow } from '../src/hooks/use-edge-glow'

const box = { left: 0, right: 280, top: 40, bottom: 840 }

describe('edge glow', () => {
  it('rests at exactly "0" away from the rail, so no style is written while the pointer is over the 3D view', () => {
    expect(edgeGlow(box, 'left', 96, 700, 400).glow).toBe('0')
    expect(edgeGlow(box, 'left', 96, 376, 400).glow).toBe('0')
    expect(edgeGlow(box, 'left', 96, 300, 1200).glow).toBe('0')
  })

  it('rises toward the inner edge and is full on it', () => {
    const far = Number(edgeGlow(box, 'left', 96, 360, 400).glow)
    const near = Number(edgeGlow(box, 'left', 96, 290, 400).glow)
    expect(near).toBeGreaterThan(far)
    expect(edgeGlow(box, 'left', 96, 280, 400).glow).toBe('1.000')
    expect(edgeGlow({ left: 1000, right: 1280, top: 40, bottom: 840 }, 'right', 96, 1000, 400).glow).toBe('1.000')
  })

  it('reports the pointer height inside the box in whole pixels', () => {
    expect(edgeGlow(box, 'left', 96, 290, 400.4).y).toBe('360px')
  })

  it('registers both variables as not inherited', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
    for (const name of ['--sx-glow', '--sx-glow-y']) {
      const rule = new RegExp(`@property ${name} \\{[^}]*inherits: false`).exec(css)
      expect(rule, name).not.toBeNull()
    }
  })
})
