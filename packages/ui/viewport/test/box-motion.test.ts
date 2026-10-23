// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMotion, ResizeSettle, type BoxAnimation } from '../src/box-motion'

interface FakeNode {
  parentNode: FakeNode | null
  contains(other: FakeNode): boolean
}

/** A node just real enough for contains() and parentNode. */
function node(parent: FakeNode | null = null): FakeNode {
  const n: FakeNode = {
    parentNode: parent,
    contains: (other) => {
      for (let at: FakeNode | null = other; at; at = at.parentNode) if (at === n) return true
      return false
    },
  }
  return n
}

function slide(target: FakeNode, property = 'width', playState = 'running') {
  let end!: () => void
  let cancel!: (e: unknown) => void
  const finished = new Promise<unknown>((res, rej) => {
    end = () => res(undefined)
    cancel = rej
  })
  const a: BoxAnimation = { playState, transitionProperty: property, effect: { target }, finished }
  return { a, end, cancel }
}

/** The app's layout: a studio holding the side pane and the view, the canvas inside the view, a bar deep in the pane. */
function layout() {
  const studio = node()
  const pane = node(studio)
  const bar = node(node(pane))
  const vp = node(studio)
  const canvas = node(vp) as unknown as Node
  return { pane, bar, vp, canvas }
}

describe('boxMotion', () => {
  it('waits on a pane sliding its width beside the view until the slide ends', async () => {
    const { pane, canvas } = layout()
    const s = slide(pane)
    let done = false
    void boxMotion(canvas, [s.a])!.then(() => {
      done = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)
    s.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(true)
  })

  it('waits on a slide held still partway, and on a transition of the view itself', () => {
    const { pane, vp, canvas } = layout()
    expect(boxMotion(canvas, [slide(pane, 'width', 'paused').a])).not.toBeNull()
    expect(boxMotion(canvas, [slide(vp, 'height').a])).not.toBeNull()
  })

  it('resolves when a slide is canceled instead of ending', async () => {
    const { pane, canvas } = layout()
    const s = slide(pane)
    const wait = boxMotion(canvas, [s.a])!
    s.cancel(new Error('canceled'))
    await expect(wait).resolves.toBeUndefined()
  })

  it('leaves out finished slides, paint-only transitions and boxes deep inside a pane', () => {
    const { pane, bar, canvas } = layout()
    expect(boxMotion(canvas, [])).toBeNull()
    expect(boxMotion(canvas, [slide(pane, 'width', 'finished').a])).toBeNull()
    expect(boxMotion(canvas, [slide(pane, 'opacity').a, slide(pane, 'transform').a, slide(pane, 'background-color').a])).toBeNull()
    expect(boxMotion(canvas, [slide(bar, 'width').a])).toBeNull()
  })
})

describe('ResizeSettle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A settle with the viewport's waits, its motion read from `moving`, counting resizes. */
  function settle(moving: () => Promise<void> | null) {
    const count = { resizes: 0, reads: 0 }
    const s = new ResizeSettle(
      () => count.resizes++,
      () => {
        count.reads++
        return moving()
      },
      { wait: 100, hold: 1000, now: () => Date.now() },
    )
    return { s, count }
  }

  it('resizes once the box keeps still for the wait, with nothing moving', async () => {
    const { s, count } = settle(() => null)
    s.schedule()
    await vi.advanceTimersByTimeAsync(60)
    s.schedule()
    await vi.advanceTimersByTimeAsync(99)
    expect(count.resizes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(count.resizes).toBe(1)
  })

  it('waits for a slide to end, then the wait again, and resizes once', async () => {
    let end!: () => void
    let slide: Promise<void> | null = new Promise<void>((r) => (end = r))
    const { s, count } = settle(() => slide)
    s.schedule()
    await vi.advanceTimersByTimeAsync(400)
    expect(count.resizes).toBe(0)
    slide = null
    end()
    await vi.advanceTimersByTimeAsync(99)
    expect(count.resizes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(count.resizes).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(count.resizes).toBe(1)
  })

  it('resizes once within the hold when a slide stays paused and never finishes', async () => {
    const never = new Promise<void>(() => {})
    const { s, count } = settle(() => never)
    s.schedule()
    await vi.advanceTimersByTimeAsync(100 + 999)
    expect(count.resizes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(count.resizes).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count.resizes).toBe(1)
  })

  it('counts the hold from the first wait when the box keeps changing during a stuck slide', async () => {
    const never = new Promise<void>(() => {})
    const { s, count } = settle(() => never)
    s.schedule()
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(150)
      s.schedule()
    }
    // The hold runs from the first wait on motion (at 100 ms), so the resize lands by 1100 ms though the slide never ends.
    await vi.advanceTimersByTimeAsync(400)
    expect(count.resizes).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count.resizes).toBe(1)
  })

  it('drops a superseded wait, so a slide ending late does not resize twice', async () => {
    let end!: () => void
    let slide: Promise<void> | null = new Promise<void>((r) => (end = r))
    const { s, count } = settle(() => slide)
    s.schedule()
    await vi.advanceTimersByTimeAsync(150)
    slide = null
    s.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(count.resizes).toBe(1)
    end()
    await vi.advanceTimersByTimeAsync(5000)
    expect(count.resizes).toBe(1)
  })

  it('says a resize is pending through the wait and a wait on motion, and not once it has run', async () => {
    let end!: () => void
    let slide: Promise<void> | null = new Promise<void>((r) => (end = r))
    const { s, count } = settle(() => slide)
    expect(s.pending).toBe(false)
    s.schedule()
    expect(s.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(s.pending).toBe(true)
    slide = null
    end()
    await vi.advanceTimersByTimeAsync(100)
    expect(count.resizes).toBe(1)
    expect(s.pending).toBe(false)
    s.schedule()
    s.dispose()
    expect(s.pending).toBe(false)
  })

  it('a slide that never ends and comes back on every read still settles: one resize, then nothing pending', async () => {
    // A view that always has a box transition running beside it (a looping slide): each read finds a new one.
    const { s, count } = settle(() => new Promise<void>(() => {}))
    s.schedule()
    await vi.advanceTimersByTimeAsync(1100)
    expect(count.resizes).toBe(1)
    expect(s.pending).toBe(false)
    // The next change of the box starts a new hold, bounded the same way.
    s.schedule()
    await vi.advanceTimersByTimeAsync(1100)
    expect(count.resizes).toBe(2)
    expect(s.pending).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count.resizes).toBe(2)
  })

  it('never resizes after dispose, from the wait or from a slide still pending', async () => {
    let end!: () => void
    const slide = new Promise<void>((r) => (end = r))
    const { s, count } = settle(() => slide)
    s.schedule()
    await vi.advanceTimersByTimeAsync(150)
    s.dispose()
    end()
    await vi.advanceTimersByTimeAsync(5000)
    s.schedule()
    await vi.advanceTimersByTimeAsync(5000)
    expect(count.resizes).toBe(0)
  })
})
