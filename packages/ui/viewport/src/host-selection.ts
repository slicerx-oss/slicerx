// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selection a host sets waits for its objects. A host can select objects the view has not built yet: a plate held
// while a project opens, or one waiting for its swap frame. The view shows the ones it has at once and the rest once
// a plate with them goes on screen. The next selection, from the host or a pick in the view, lets go of whatever still
// waits, so an id that never comes is not left to turn up later.

export class HostSelection {
  private pending: string[] | null = null

  /** The ids the host asked for while some of them have no object yet; null when nothing waits. */
  get waiting(): readonly string[] | null {
    return this.pending
  }

  /** The host's selection: returns what shows now. The ids without an object wait for one. */
  set(ids: readonly string[], has: (id: string) => boolean): string[] {
    const shown = ids.filter(has)
    this.pending = shown.length < ids.length ? [...ids] : null
    return shown
  }

  /** A selection made in the view itself: nothing the host asked for waits any more. */
  pick(): void {
    this.pending = null
  }

  /** The objects changed: returns what shows now, from what waits, or else from `current` less what is gone. */
  rebuilt(current: readonly string[], has: (id: string) => boolean): string[] {
    if (!this.pending) return current.filter(has)
    const shown = this.pending.filter(has)
    if (shown.length === this.pending.length) this.pending = null
    return shown
  }
}
