// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scene hold while a file opens: the old scene stays until the first plate with objects, which swaps in on the next
// frame. Whatever the view is given before that frame is what swaps in, so the last plate given is the one drawn.
import { describe, expect, it } from 'vitest'
import { SceneHold } from '../src/scene-hold'

type P = { name: string; objects: string[] }
const plate = (name: string, ...objects: string[]): P => ({ name, objects })

/** The view's side: what a frame or a release puts on screen, and what goes on at once. */
function view() {
  const hold = new SceneHold<P, string>()
  const drawn: string[] = []
  let preview: string | null = null
  const apply = (h: ReturnType<typeof hold.release>) => {
    if (h?.preview !== undefined) preview = h.preview
    if (h?.plate) drawn.push(h.plate[0].name)
  }
  return {
    hold,
    setPlate: (p: P) => {
      if (hold.plate(p, {}) === 'now') drawn.push(p.name)
    },
    setPreview: (b: string | null) => {
      if (!hold.preview(b)) preview = b
    },
    frame: () => apply(hold.takeSwap()),
    release: () => apply(hold.release()),
    shown: () => drawn.at(-1),
    preview: () => preview,
  }
}

describe('SceneHold', () => {
  it('keeps the old scene through an empty plate and swaps the first model in on the next frame', () => {
    const v = view()
    v.setPlate(plate('old', 'a'))
    v.hold.hold()
    v.setPlate(plate('empty'))
    expect(v.shown()).toBe('old')
    v.setPlate(plate('new', 'b'))
    expect(v.shown()).toBe('old')
    expect(v.hold.waiting).toBe(true)
    v.frame()
    expect(v.shown()).toBe('new')
    expect(v.hold.waiting).toBe(false)
  })

  it('draws the last plate given before the swap frame, not the first model that ended the hold', () => {
    // Opening a two-plate project: plate 2 loads into view, then plate 1 is shown again before the next frame.
    const v = view()
    v.setPlate(plate('plate 1', 'white'))
    v.hold.hold()
    v.setPlate(plate('plate 2', 'charcoal'))
    v.setPlate(plate('plate 1', 'white'))
    v.frame()
    expect(v.shown()).toBe('plate 1')
    v.frame()
    expect(v.shown()).toBe('plate 1')
  })

  it('waits again when held again before the swap frame, then draws the last plate given', () => {
    // Opening a two-plate project over an open one: plate 1 ends the hold, the open moves on to an empty plate 2 (which
    // holds again), plate 2 loads, then plate 1 is shown again, all before the next frame.
    const v = view()
    v.setPlate(plate('old', 'a'))
    v.hold.hold()
    v.setPlate(plate('empty'))
    v.setPlate(plate('plate 1', 'white'))
    v.hold.hold()
    v.setPlate(plate('plate 2 empty'))
    v.frame()
    expect(v.shown()).toBe('old')
    v.setPlate(plate('plate 2', 'charcoal'))
    v.setPlate(plate('plate 1', 'white'))
    v.frame()
    expect(v.shown()).toBe('plate 1')
    expect(v.hold.waiting).toBe(false)
  })

  it('takes a preview given before the swap frame over the one held', () => {
    const v = view()
    v.setPreview('old paths')
    v.hold.hold()
    v.setPreview(null)
    v.setPlate(plate('new', 'b'))
    v.setPreview('new paths')
    v.frame()
    expect(v.preview()).toBe('new paths')
  })

  it('lets everything through at once when released, and goes straight on screen when not holding', () => {
    const v = view()
    v.hold.hold()
    v.setPlate(plate('empty'))
    v.release()
    expect(v.shown()).toBe('empty')
    v.setPlate(plate('later', 'c'))
    expect(v.shown()).toBe('later')
    expect(v.hold.waiting).toBe(false)
  })
})
