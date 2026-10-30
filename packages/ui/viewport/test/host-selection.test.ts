// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The host's selection waits for its objects: ids the view has not built yet (a plate held while a project opens, or
// waiting for its swap frame) show once the plate with them goes on screen. Ids that never come are let go at the next
// selection, from the host or a pick in the view, so nothing stale is left to turn up later.
import { describe, expect, it } from 'vitest'
import { HostSelection } from '../src/host-selection'
import { SceneHold } from '../src/scene-hold'

type P = { objects: string[] }

/** The view's side: the objects drawn now, a scene hold in front of them, and the selection it shows. */
function view(...drawn: string[]) {
  const hold = new SceneHold<P, string>()
  const kept = new HostSelection()
  let objects = new Set(drawn)
  let selection: string[] = []
  const has = (id: string) => objects.has(id)
  const draw = (p: P) => {
    objects = new Set(p.objects)
    selection = kept.rebuilt(selection, has)
  }
  return {
    hold,
    setPlate: (p: P) => {
      if (hold.plate(p, {}) === 'now') draw(p)
    },
    /** The swap frame (or the release of a hold) puts what waited on screen. */
    frame: () => {
      const h = hold.takeSwap()
      if (h?.plate) draw(h.plate[0])
    },
    setSelection: (ids: string[]) => {
      selection = kept.set(ids, has)
    },
    pick: (ids: string[]) => {
      kept.pick()
      selection = ids
    },
    selection: () => selection,
    waiting: () => kept.waiting,
  }
}

describe('the host selection waits for its objects', () => {
  it('a selection set before the parts are built shows once they are', () => {
    const v = view()
    v.setSelection(['a', 'b'])
    expect(v.selection()).toEqual([])
    v.setPlate({ objects: ['a', 'b'] })
    expect(v.selection()).toEqual(['a', 'b'])
    expect(v.waiting()).toBeNull()
  })

  it('a selection set while an open holds the plate shows on the swap frame, in the order the host gave', () => {
    const v = view('old')
    v.hold.hold(true)
    v.setPlate({ objects: ['b', 'a'] })
    v.setSelection(['a', 'b'])
    expect(v.selection()).toEqual([])
    v.hold.swapOnRelease()
    v.frame()
    expect(v.selection()).toEqual(['a', 'b'])
  })

  it('during a rebuild that keeps one part and brings the other, both end up selected', () => {
    const v = view('a')
    v.hold.hold()
    v.setPlate({ objects: ['a', 'b'] })
    v.setSelection(['a', 'b'])
    // the part the view has shows at once
    expect(v.selection()).toEqual(['a'])
    v.frame()
    expect(v.selection()).toEqual(['a', 'b'])
  })

  it('an id that never comes is let go at the next selection from the host', () => {
    const v = view('a')
    v.setSelection(['a', 'x'])
    expect(v.selection()).toEqual(['a'])
    expect(v.waiting()).toEqual(['a', 'x'])
    v.setSelection(['a'])
    expect(v.waiting()).toBeNull()
    v.setPlate({ objects: ['a', 'x'] })
    expect(v.selection()).toEqual(['a'])
  })

  it('a pick in the view lets go of what waited', () => {
    const v = view('a')
    v.setSelection(['x'])
    v.pick(['a'])
    expect(v.waiting()).toBeNull()
    v.setPlate({ objects: ['a', 'x'] })
    expect(v.selection()).toEqual(['a'])
  })

  it('without anything waiting, a rebuild keeps only the selected objects still there, as before', () => {
    const v = view('a', 'b')
    v.setSelection(['a', 'b'])
    v.setPlate({ objects: ['b'] })
    expect(v.selection()).toEqual(['b'])
    // a part that comes back later is not selected again on its own
    v.setPlate({ objects: ['a', 'b'] })
    expect(v.selection()).toEqual(['b'])
  })

  it('a part that waits still shows when an earlier rebuild drops the other one', () => {
    const v = view('a')
    v.setSelection(['a', 'b'])
    v.setPlate({ objects: ['b'] })
    expect(v.selection()).toEqual(['b'])
    v.setPlate({ objects: ['a', 'b'] })
    expect(v.selection()).toEqual(['a', 'b'])
    expect(v.waiting()).toBeNull()
  })
})
