// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A menu or popover that would reach past a layer it sits in is lifted out, so the page after that layer can't cover it.
import { describe, expect, it } from 'vitest'
import { makesLayer, reachesPast, type LayerStyle } from '../src/hooks/use-placement'

const plain: LayerStyle = { position: 'static', zIndex: 'auto', transform: 'none', filter: 'none', opacity: '1', isolation: 'auto', contain: 'none' }

describe('a layer of its own', () => {
  it('is not made by a plain box or a positioned one without a z-index', () => {
    expect(makesLayer(plain)).toBe(false)
    expect(makesLayer({ ...plain, position: 'relative' })).toBe(false)
    expect(makesLayer({ ...plain, position: 'absolute', translate: 'none', backdropFilter: 'none', mixBlendMode: 'normal', willChange: 'auto' })).toBe(false)
  })

  it('is made by a transform, as on a folding block header, and by the other usual causes', () => {
    expect(makesLayer({ ...plain, position: 'absolute', transform: 'matrix(1, 0, 0, 1, 0, -15)' })).toBe(true)
    expect(makesLayer({ ...plain, position: 'relative', zIndex: '2' })).toBe(true)
    expect(makesLayer({ ...plain, position: 'fixed' })).toBe(true)
    expect(makesLayer({ ...plain, opacity: '0.9' })).toBe(true)
    expect(makesLayer({ ...plain, backdropFilter: 'blur(18px)' })).toBe(true)
    expect(makesLayer({ ...plain, isolation: 'isolate' })).toBe(true)
    expect(makesLayer({ ...plain, contain: 'paint' })).toBe(true)
  })
})

describe('reaching past a layer', () => {
  const layer = { left: 100, top: 100, right: 200, bottom: 130 }
  it('is false inside it, to the pixel', () => {
    expect(reachesPast({ left: 100, top: 100, right: 200, bottom: 130 }, layer)).toBe(false)
    expect(reachesPast({ left: 99.5, top: 100, right: 200.5, bottom: 130 }, layer)).toBe(false)
  })
  it('is true for a menu hanging below a header', () => {
    expect(reachesPast({ left: 0, top: 134, right: 200, bottom: 266 }, layer)).toBe(true)
  })
})
