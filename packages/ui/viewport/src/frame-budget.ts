// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When the whole view has to step down to keep orbiting smooth, and when it may come back, decided from what the GPU
// takes to draw a frame. The time between animation frames is not used for this: it also counts the page's own work
// (opening a project, building meshes, compiling shaders), and a stall there says nothing about the GPU. Each sample
// is the time from starting a frame until the GPU has finished it, found with a fence (gpudone.ts, FrameFence), so a
// busy page with an idle GPU reads as fast.

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
