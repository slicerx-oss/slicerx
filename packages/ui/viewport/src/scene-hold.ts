// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scene hold while a file opens: the old scene stays on screen, an empty plate and a cleared preview wait, and the
// first plate with objects swaps in on the next frame under a crossfade. Kept apart from the view so it can be tested.

/** What waits to go on screen: the plate and its options, and the preview (null clears it). */
export interface Held<P, B> {
  plate?: [P, { keepCamera?: boolean }]
  preview?: B | null
}

export class SceneHold<P extends { objects: readonly unknown[] }, B> {
  private held: Held<P, B> | null = null
  private swap: Held<P, B> | null = null

  /** A hold or a swap waits. */
  get waiting(): boolean {
    return this.held !== null || this.swap !== null
  }

  /** Starts holding (a hold already on stays as it is). */
  hold(): void {
    this.held ??= {}
  }

  /** Stops holding: what waited, to go on screen at once, or null. */
  release(): Held<P, B> | null {
    const h = this.held
    this.held = null
    return h
  }

  /**
   * A plate for the view: 'held' when it waits, 'swap' when it is the first plate with objects and swaps in on the
   * next frame, 'now' when it goes on screen at once.
   */
  plate(plate: P, opts: { keepCamera?: boolean }): 'held' | 'swap' | 'now' {
    if (!this.held) return 'now'
    this.held.plate = [plate, opts]
    if (plate.objects.length === 0) return 'held'
    this.swap = this.held
    this.held = null
    return 'swap'
  }

  /** A preview for the view: true when it waits. */
  preview(buffers: B | null): boolean {
    if (!this.held) return false
    this.held.preview = buffers
    return true
  }

  /** The frame drew the old scene: what swaps in now, or null. */
  takeSwap(): Held<P, B> | null {
    const s = this.swap
    this.swap = null
    return s
  }
}
