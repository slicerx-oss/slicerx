// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the canvas's box is still moving. A pane beside the view slides its width over several frames, and the
// viewport sizes its buffer a short wait after the box last changed. On a busy machine a frame can come later than
// that wait, so the buffer was sized for a box the slide was about to leave, then sized again where it stopped.

/** The properties whose transition moves or sizes a box, and with it the boxes laid out beside it. */
const LAYOUT = /^(all|width|height|(min|max)-(width|height)|flex(-basis|-grow|-shrink)?|grid-template-(columns|rows)|inset|left|right|top|bottom|(margin|padding)(-(left|right|top|bottom|inline|block))?)$/

/** The parts of a running animation this reads (a CSSTransition in a browser). */
export interface BoxAnimation {
  playState: string
  transitionProperty?: string
  effect: { target?: unknown } | null
  finished: Promise<unknown>
}

/**
 * The transitions that can still move `canvas`'s box: a layout property moving on an element whose parent holds the
 * canvas (the view itself, or a pane beside it). Resolves once they have all ended (or were canceled), or null when
 * none is moving. A transition somewhere else on the page, such as a progress bar inside a pane, does not count.
 */
export function boxMotion(canvas: Node, animations: readonly BoxAnimation[]): Promise<void> | null {
  const moving = animations.filter((a) => {
    if (a.playState !== 'running' && a.playState !== 'paused') return false
    if (!a.transitionProperty || !LAYOUT.test(a.transitionProperty)) return false
    const target = a.effect?.target as Node | null | undefined
    const parent = target?.parentNode
    return !!parent && parent.contains(canvas)
  })
  if (!moving.length) return null
  const settle = () => undefined
  return Promise.all(moving.map((a) => a.finished.then(settle, settle))).then(settle)
}

/** The waits ResizeSettle uses, ms, and its clock. */
export interface ResizeSettleTiming {
  /** How long the box must keep still before a resize. */
  wait: number
  /** The longest a resize waits on motion in all, counted from its first wait on it. */
  hold: number
  now: () => number
}

/**
 * Runs `resize` once the canvas box has kept still for `wait` ms and `motion` reports nothing still moving it. A wait
 * on motion ends when the motion does or when `hold` runs out, whichever comes first, so a transition that stays
 * paused or never finishes delays the resize by at most `hold`. A newer schedule() or dispose() drops any wait still
 * pending, so a stale one never resizes twice or after dispose.
 */
export class ResizeSettle {
  private timer: ReturnType<typeof setTimeout> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private heldSince: number | null = null
  private generation = 0
  private disposed = false

  constructor(
    private readonly resize: () => void,
    private readonly motion: () => Promise<void> | null,
    private readonly timing: ResizeSettleTiming,
  ) {}

  /** The box changed: resize once it settles. */
  schedule(): void {
    if (this.disposed) return
    const generation = ++this.generation
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || generation !== this.generation) return
      const now = this.timing.now()
      if (this.heldSince === null) this.heldSince = now
      const left = this.timing.hold - (now - this.heldSince)
      const moving = left > 0 ? this.motion() : null
      if (!moving) return this.run()
      const held = new Promise<'held'>((resolve) => {
        this.holdTimer = setTimeout(() => resolve('held'), left)
      })
      void Promise.race([moving.then(() => 'moved' as const), held]).then((why) => {
        if (this.disposed || generation !== this.generation) return
        if (this.holdTimer !== null) clearTimeout(this.holdTimer)
        this.holdTimer = null
        // Still moving after the whole hold: size the buffer for the box as it is now.
        if (why === 'held') this.run()
        else this.schedule()
      })
    }, this.timing.wait)
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.clear()
  }

  private run(): void {
    this.heldSince = null
    this.resize()
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.timer = null
    this.holdTimer = null
  }
}
