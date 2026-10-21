// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When a bottom panel (Design's timeline, Slice's plate bar) opens and closes by itself. It opens 120 ms after the
// pointer enters the band along the bottom of the view (a pass across it on the way elsewhere does not open it), at
// once from its tab, and for attention (a new estimate, a step that broke) for 4 s. It closes 600 ms after the pointer
// leaves both the band and the panel, and never while the pointer is over it, focus is inside it, a menu from it is
// open or a drag in it is under way. Pinned, it stays open. Touch has no hover: a tap on the tab toggles it. A press
// on the tab while it is open by itself (for attention, or from the band) keeps it open until the next press: the
// person did not open it, so the press means keep it. The pointer resting on the tab opens nothing from the band: the
// tab rides up with the panel, so opening there would pull it out from under the pointer and a click aimed at it would
// land on the panel. Over the tab of an open panel, the pointer holds it open like the panel itself.

export const OPEN_DELAY_MS = 120
export const CLOSE_DELAY_MS = 600
export const ATTENTION_MS = 4000

export interface AutoPanelState {
  open: boolean
}

export class AutoPanel {
  open = false
  private inBand = false
  private overPanel = false
  private overTab = false
  private focused = false
  private menu = false
  private dragging = false
  private pinned: boolean
  private openTimer: ReturnType<typeof setTimeout> | undefined
  private closeTimer: ReturnType<typeof setTimeout> | undefined
  /** Opened for attention while it was closed: it closes again after ATTENTION_MS unless something holds it. */
  private forAttention = false
  /** Opened from the tab (or the keys), rather than by itself. */
  private fromTab = false
  /** Kept open by a press on the tab while it was open by itself: held until the next press or Escape. */
  private kept = false

  constructor(
    private readonly onChange: (open: boolean) => void,
    opts: { pinned?: boolean } = {},
  ) {
    this.pinned = opts.pinned ?? false
    if (this.pinned) this.open = true
  }

  private set(open: boolean): void {
    if (open === this.open) return
    this.open = open
    if (!open) this.fromTab = this.kept = false
    this.onChange(open)
  }

  private clear(): void {
    clearTimeout(this.openTimer)
    clearTimeout(this.closeTimer)
    this.openTimer = undefined
    this.closeTimer = undefined
  }

  /** Something keeps it open right now. */
  private held(): boolean {
    return this.pinned || this.kept || this.inBand || this.overPanel || this.overTab || this.focused || this.menu || this.dragging
  }

  private scheduleClose(delay = CLOSE_DELAY_MS): void {
    clearTimeout(this.closeTimer)
    if (this.held()) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined
      if (!this.held()) {
        this.forAttention = false
        this.set(false)
      }
    }, delay)
  }

  band(inside: boolean): void {
    this.inBand = inside
    if (inside) {
      clearTimeout(this.closeTimer)
      this.armOpen()
    } else {
      clearTimeout(this.openTimer)
      this.openTimer = undefined
      if (this.open) this.scheduleClose()
    }
  }

  /** Starts the band's open delay, unless it is open, already waiting, or the pointer is on the tab. */
  private armOpen(): void {
    if (this.open || this.overTab || this.openTimer !== undefined) return
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined
      if (this.inBand && !this.overTab) this.set(true)
    }, OPEN_DELAY_MS)
  }

  /** The pointer on the tab: the band waits while it rests there, and an open panel stays open. */
  tab(over: boolean): void {
    if (over === this.overTab) return
    this.overTab = over
    if (over) {
      clearTimeout(this.openTimer)
      this.openTimer = undefined
      clearTimeout(this.closeTimer)
    } else if (this.open) this.scheduleClose()
    else if (this.inBand) this.armOpen()
  }

  panel(over: boolean): void {
    this.overPanel = over
    if (over) {
      clearTimeout(this.closeTimer)
      this.forAttention = false
    } else if (this.open) this.scheduleClose()
  }

  focus(inside: boolean): void {
    this.focused = inside
    if (inside) {
      this.clear()
      this.forAttention = false
      this.set(true)
    } else if (this.open) this.scheduleClose()
  }

  menuOpen(open: boolean): void {
    this.menu = open
    if (!open && this.open) this.scheduleClose()
  }

  drag(active: boolean): void {
    this.dragging = active
    if (!active && this.open) this.scheduleClose()
  }

  /**
   * The tab, clicked or tapped: opens at once, or closes when it was open. Open by itself, it stays open instead.
   * The panel key (Mod+J) passes keep false: it opens or closes whatever opened the panel.
   */
  toggle(keep = true): void {
    this.clear()
    this.forAttention = false
    if (keep && this.open && !this.fromTab && !this.kept && !this.pinned) {
      this.kept = true
      return
    }
    this.fromTab = !this.open
    this.set(!this.open)
  }

  /** Escape: closes now, unless pinned. */
  close(): void {
    if (this.pinned) return
    this.clear()
    this.forAttention = false
    this.set(false)
  }

  /** Something the person should see happened in the panel: open it, and close it again after a while if it was closed. */
  attention(): void {
    if (this.open) return
    this.clear()
    this.forAttention = true
    this.set(true)
    this.scheduleClose(ATTENTION_MS)
  }

  pin(on: boolean): void {
    this.pinned = on
    if (on) {
      this.clear()
      this.set(true)
    } else this.scheduleClose()
  }

  get isPinned(): boolean {
    return this.pinned
  }

  dispose(): void {
    this.clear()
  }
}
