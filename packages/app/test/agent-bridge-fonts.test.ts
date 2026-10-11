// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { loadFaces } from '../src/agent-bridge/fonts'

/** A stand-in FontFace: load() resolves, rejects as a refused face does, or never ends. */
function face(family: string, unicodeRange: string, outcome: 'loaded' | 'error' | 'hang'): FontFace {
  const f = { family, weight: '100 900', style: 'normal', unicodeRange, status: 'unloaded' as FontFaceLoadStatus } as unknown as FontFace & { status: FontFaceLoadStatus }
  ;(f as unknown as { load(): Promise<FontFace> }).load = () => {
    if (outcome === 'hang') {
      ;(f as { status: FontFaceLoadStatus }).status = 'loading'
      return new Promise<FontFace>(() => undefined)
    }
    ;(f as { status: FontFaceLoadStatus }).status = outcome
    return outcome === 'loaded' ? Promise.resolve(f) : Promise.reject(new DOMException('A network error occurred.', 'NetworkError'))
  }
  return f
}

describe('the bridge font check', () => {
  it('loads every face, the ones no text needs included, and says how each ended', async () => {
    const faces = [face('"Unbounded Variable"', 'U+0000-00FF', 'loaded'), face('Unbounded Variable', 'U+0460-052F, U+1C80-1C8A, U+20B4', 'error'), face('Inter Variable', 'U+0000-00FF', 'loaded')]
    const r = await loadFaces(faces, null)
    expect(r.map((x) => [x.family, x.unicodeRange, x.status])).toEqual([
      ['Unbounded Variable', 'U+0000-00FF', 'loaded'],
      ['Unbounded Variable', 'U+0460-052F, U+1C80-1C8A, U+20B4', 'error'],
      ['Inter Variable', 'U+0000-00FF', 'loaded'],
    ])
    expect(r[1]!.error).toBe('NetworkError: A network error occurred.')
  })

  it('keeps to the families asked for, and reports a face that does not end in time as loading', async () => {
    const r = await loadFaces([face('Inter Variable', '', 'loaded'), face('JetBrains Mono Variable', '', 'hang')], ['JetBrains Mono Variable'], 50)
    expect(r).toEqual([{ family: 'JetBrains Mono Variable', weight: '100 900', style: 'normal', unicodeRange: '', status: 'loading' }])
  })
})
