// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scene hold while a file opens: the old scene stays on screen, an empty plate and a cleared preview wait, and the
// first plate with objects swaps in on the next frame under a crossfade. Whatever the view is given until that frame
// replaces what waits, so the frame swaps in the latest plate and preview, never an earlier one. Kept apart from the
// view so it can be tested.

/** What waits to go on screen: the plate and its options, and the preview (null clears it). */
export interface Held<P, B> {
  plate?: [P, { keepCamera?: boolean }]
  preview?: B | null
}

export class SceneHold<P extends { objects: readonly unknown[] }, B> {
  /** What waits for the swap frame or the release; null when nothing does and everything goes on screen at once. */
  private pending: Held<P, B> | null = null
  /** Waiting for a plate with objects (an empty plate waits too). */
  private holding = false
  /** A plate with objects came: the next frame swaps in what waits then. */
  private due = false

  /** A hold or a swap waits. */
  get waiting(): boolean {
    return this.pending !== null
  }

  /** Starts holding. What already waits for a swap keeps waiting, and the swap waits for a plate with objects again. */
  hold(): void {
    this.pending ??= {}
    this.holding = true
  }

  /** Stops holding: what waited, to go on screen at once, or null. */
  release(): Held<P, B> | null {
    const h = this.pending
    this.pending = null
    this.holding = false
    this.due = false
    return h
  }

  /**
   * A plate for the view: 'now' when it goes on screen at once, 'held' when it waits, 'swap' when it waits for the
   * next frame, which swaps it in (the view asks for that frame).
   */
  plate(plate: P, opts: { keepCamera?: boolean }): 'held' | 'swap' | 'now' {
    if (!this.pending) return 'now'
    this.pending.plate = [plate, opts]
    if (this.holding && plate.objects.length > 0) {
      this.holding = false
      this.due = true
    }
    return this.due && !this.holding ? 'swap' : 'held'
  }

  /** A preview for the view: true when it waits. */
  preview(buffers: B | null): boolean {
    if (!this.pending) return false
    this.pending.preview = buffers
    return true
  }

  /** The frame drew the old scene: what swaps in now, or null. */
  takeSwap(): Held<P, B> | null {
    if (!this.due || this.holding) return null
    return this.release()
  }
}
