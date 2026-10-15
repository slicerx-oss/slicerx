// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much of the still frame's quality moving frames can afford, and when the whole view has to step down, decided
// from what the GPU takes to draw a frame. The time between animation frames is not used for this: it also counts the page's own work
// (opening a project, building meshes, compiling shaders), and a stall there says nothing about the GPU. Each sample
// is the time from starting a frame until the GPU has finished it, found with a fence (gpudone.ts, FrameFence), so a
// busy page with an idle GPU reads as fast.

/** A moving frame's quality: `full` draws it exactly as a still frame (MSAA and AO); otherwise `scale` is its side length. */
export interface MotionLevel {
  full: boolean
  scale: number
}

/** Over this, ms, a moving frame misses 60 fps. */
export const MOTION_SLOW_MS = 18
/** Under this, ms, a moving frame has room for the next step up. */
export const MOTION_FAST_MS = 11
/** Moving frames never go below this side length (0.6 keeps about a third of the pixels). */
export const MOTION_FLOOR = 0.6
/** On a weak GPU they may go lower, but never below this. */
export const MOTION_FLOOR_WEAK = 0.5
/** Samples the median is taken over. */
const WINDOW = 6
/** Fast samples in a row before stepping up, at first. A step up undone soon after doubles it. */
const RAISE_AFTER = 30
const RAISE_AFTER_MAX = 480

const median = (xs: readonly number[]): number => {
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/**
 * Moving frames start at full quality. While the GPU takes too long for 60 fps they first drop MSAA and AO, then shrink
 * (by the square root of the time to win back, since cost follows the pixel count) down to the floor; while it has
 * room they step back up.
 */
export class MotionTuner {
  full = true
  scale = 1
  private readonly floor: number
  private recent: number[] = []
  private fastRun = 0
  private raiseAfter = RAISE_AFTER
  /** Samples since the last step up, or -1 when there was none to undo. */
  private sinceRaise = -1

  constructor(opts: { weak?: boolean } = {}) {
    this.floor = opts.weak ? MOTION_FLOOR_WEAK : MOTION_FLOOR
    // A weak GPU starts a step down: its first orbit is then smooth, and it steps up if it can.
    if (opts.weak) this.full = false
  }

  /** Moving frames are as small as they go. */
  get atFloor(): boolean {
    return !this.full && this.scale <= this.floor
  }

  get level(): MotionLevel {
    return { full: this.full, scale: this.full ? 1 : this.scale }
  }

  /** One moving frame's GPU time, ms. True when the level changed. */
  sample(ms: number): boolean {
    this.recent.push(ms)
    if (this.recent.length > WINDOW) this.recent.shift()
    if (this.sinceRaise >= 0) this.sinceRaise++
    if (ms < MOTION_FAST_MS) this.fastRun++
    else this.fastRun = 0
    if (this.recent.length >= 4 && median(this.recent) > MOTION_SLOW_MS) return this.lower(median(this.recent))
    if (this.fastRun >= this.raiseAfter) return this.raise()
    return false
  }

  private lower(ms: number): boolean {
    this.recent = []
    this.fastRun = 0
    // a step up that did not hold: wait longer before the next try
    if (this.sinceRaise >= 0 && this.sinceRaise < 120) this.raiseAfter = Math.min(this.raiseAfter * 2, RAISE_AFTER_MAX)
    this.sinceRaise = -1
    if (this.full) {
      this.full = false
      this.scale = 1
      return true
    }
    if (this.scale <= this.floor) return false
    const next = Math.min(this.scale - 0.05, this.scale * Math.sqrt(MOTION_SLOW_MS / ms))
    this.scale = Math.max(this.floor, Math.round(next * 20) / 20)
    return true
  }

  private raise(): boolean {
    this.fastRun = 0
    this.recent = []
    if (this.full) return false
    if (this.scale < 1) this.scale = Math.min(1, Math.round((this.scale + 0.1) * 20) / 20)
    else this.full = true
    this.sinceRaise = 0
    return true
  }
}

/** Over this, ms, a moving frame at the floor cannot hold even 30 fps. */
export const DEGRADE_MS = 34
/** A view stepped down may come back once full frames would take under this, ms. */
const RECOVER_MS = 14
const DEGRADE_SAMPLES = 8
const RECOVER_SAMPLES = 60

/**
 * The last resort, under the motion tuner: when moving frames at the floor still take too long, the view turns AO off
 * and draws at a pixel ratio of 1. It comes back when frames at that size show the full size would be fast again
 * (a project closed, the GPU no longer shared), so one bad stretch does not leave a fast GPU at 1x for the session.
 */
export class DegradeGuard {
  degraded = false
  private slow = 0
  private fast = 0
  private recoverAfter = RECOVER_SAMPLES

  /**
   * One frame's GPU time, ms. `atFloor`: moving frames are already as small as they go. `areaRatio`: pixels at the full
   * pixel ratio over pixels now (4 on a 2x screen while degraded). Returns 'degrade', 'recover' or null.
   */
  sample(ms: number, atFloor: boolean, areaRatio: number): 'degrade' | 'recover' | null {
    if (!this.degraded) {
      if (!atFloor) {
        this.slow = 0
        return null
      }
      this.slow = ms > DEGRADE_MS ? this.slow + 1 : Math.max(0, this.slow - 1)
      if (this.slow < DEGRADE_SAMPLES) return null
      this.slow = 0
      this.fast = 0
      this.degraded = true
      return 'degrade'
    }
    // the full size would cost about this; AO adds a little on top, so the bar is kept low
    this.fast = ms * areaRatio < RECOVER_MS ? this.fast + 1 : 0
    if (this.fast < this.recoverAfter) return null
    this.fast = 0
    this.degraded = false
    // if it has to step down again, it waits twice as long before the next try
    this.recoverAfter = Math.min(this.recoverAfter * 2, RECOVER_SAMPLES * 16)
    return 'recover'
  }
}
