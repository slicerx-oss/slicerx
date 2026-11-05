// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse as continuous camera input: holds the device's latest frame and, once per drawn frame, moves the camera
// rig by what the cap asks for over the time since the last frame (spacemouse.ts has the mapping). The viewport calls
// step() from its frame loop and keeps drawing while it answers true.
import type { Vector3 } from 'three'
import type { CameraRig } from './camera'
import { axesAtRest, DEFAULT_SPACE_MOUSE, normalizeSpaceMouse, SPACE_MAX_STEP_MS, SPACE_REST, SPACE_SMOOTH_MS, SPACE_STALE_MS, smoothAxes, spaceAxes, spaceMotion, ZERO_FRAME, type SpaceAxis, type SpaceFrame, type SpaceMouseSettings } from './spacemouse'

export type SpaceRig = Pick<CameraRig, 'panBy' | 'orbitBy' | 'go' | 'zoomed' | 'retargetToDepthOf' | 'move' | 'preset'>

export interface SpaceStepOptions {
  /** The view's height in pixels. */
  heightPx: number
  /** Reduced motion: no smoothing, so the view stops the moment the cap is let go. */
  reduced: boolean
  /** The point orbits turn around when a push starts from rest, or null to keep the current orbit center. */
  pivot: () => Vector3 | null
}

export class SpaceDrive {
  settings: SpaceMouseSettings = DEFAULT_SPACE_MOUSE
  private frame: SpaceFrame = ZERO_FRAME
  private at = 0
  private axes: Record<SpaceAxis, number> = { ...SPACE_REST }
  private lastT = 0

  /** Merges settings in; turning it off stops any motion. */
  set(settings: Partial<SpaceMouseSettings>): void {
    this.settings = normalizeSpaceMouse({ ...this.settings, ...settings, invert: { ...this.settings.invert, ...settings.invert } })
    if (!this.settings.enabled) this.stop()
  }

  /** The device's latest six axes in raw counts, received at `now` (ms). Ignored while off. Answers whether it was taken. */
  input(frame: SpaceFrame, now: number): boolean {
    if (!this.settings.enabled) return false
    this.frame = { ...frame }
    this.at = now
    return true
  }

  stop(): void {
    this.frame = ZERO_FRAME
    this.axes = { ...SPACE_REST }
    this.lastT = 0
  }

  /** Still moving: the frame loop keeps drawing while true. */
  get active(): boolean {
    return this.lastT !== 0
  }

  /**
   * One frame of motion at `now` (ms): pan, zoom and orbit by what the cap asks for since the last frame. A push from
   * rest takes over from a camera move under way and turns around `pivot`. True when the camera moved.
   */
  step(now: number, rig: SpaceRig, o: SpaceStepOptions): boolean {
    if (!this.settings.enabled) {
      if (this.lastT) this.stop()
      return false
    }
    // a lost release report must not move the view forever
    if (this.frame !== ZERO_FRAME && now - this.at > SPACE_STALE_MS) this.frame = ZERO_FRAME
    const target = spaceAxes(this.frame, this.settings)
    const resting = axesAtRest(this.axes)
    if (resting && axesAtRest(target)) {
      this.lastT = 0
      return false
    }
    const dt = this.lastT ? Math.min(SPACE_MAX_STEP_MS, Math.max(0, now - this.lastT)) : 1000 / 60
    this.lastT = now
    this.axes = smoothAxes(this.axes, target, dt, o.reduced ? 0 : SPACE_SMOOTH_MS)
    const m = spaceMotion(this.axes, this.settings.sensitivity, dt)
    if (!m) {
      this.lastT = 0
      return false
    }
    if (resting) {
      rig.move = null
      const p = o.pivot()
      if (p) rig.retargetToDepthOf(p)
    }
    const h = Math.max(1, o.heightPx)
    // panBy moves the camera, so the scene goes the other way: a positive x slides the scene right, a negative y up
    if (m.panX || m.panY) rig.panBy(m.panX * h, -m.panY * h, h)
    // orbitBy at speed 1 turns 2 pi per view height
    if (m.orbitX || m.orbitY) rig.orbitBy((m.orbitX * h) / (2 * Math.PI), (m.orbitY * h) / (2 * Math.PI), h, 1)
    if (m.zoom !== 1) rig.go(rig.zoomed(m.zoom), false, now)
    rig.preset = null
    return true
  }
}
