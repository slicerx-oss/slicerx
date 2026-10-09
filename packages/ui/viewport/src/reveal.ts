// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first plate reveal: once per window, the model draws, then two light crackles trace the plate outline from the
// front and meet at the back, a soft accent bloom and sparks mark the hit, a wash lands on the plate and the grid lays
// down row by row, back to front. The plate itself is drawn by the plate shader (stage.ts) from one uniform a frame;
// the crackles, bloom and sparks are a 2D overlay over the view that is only there while they run.
import { Vector3, type Camera } from 'three'

/** Wait between the first frame with the model and the start of the trace. */
export const REVEAL_DELAY_MS = 200
/** The two crackles run from the front middle to the back middle in this time. */
export const REVEAL_TRACE_MS = 760
/** The grid starts this long after the hit. */
export const REVEAL_GRID_AFTER_MS = 140
/** The grid's front row starts this long after its back row. */
export const REVEAL_GRID_SPAN_MS = 640
/** Each row's rise and overshoot. */
export const REVEAL_GRID_SETTLE_MS = 220
/** The whole reveal from the start of the trace. */
export const REVEAL_END_MS = REVEAL_TRACE_MS + REVEAL_GRID_AFTER_MS + REVEAL_GRID_SPAN_MS + REVEAL_GRID_SETTLE_MS + 60
/** The plate as it always looks: traced, grid down, no wash. */
export const REVEAL_SETTLED = { trace: 1, gridMs: 1e9, tint: 0 } as const
/** The plate before the trace starts: nothing drawn. */
export const REVEAL_HIDDEN = { trace: -1, gridMs: -1, tint: 0 } as const

const BLOOM_MS = 380
const SPARK_MS = 300
const SPARKS = 10
const TAIL = 0.14
const TAIL_POINTS = 14
const AMP = 2.2
const CORE = 1.1
const GLOW = 6
const GLOW_ALPHA = 0.17
const SIDES = [1, -1] as const

/** One frame of the reveal's plate: what setReveal takes. */
export interface RevealPlate {
  trace: number
  gridMs: number
  tint: number
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/**
 * The plate at `ms` from the start of the trace, written into `out`. The wash swells on the hit, eases down to a faint
 * tint while the grid lands and is gone by the end, so the plate ends on its normal look.
 */
export function revealPlate(ms: number, out: RevealPlate): RevealPlate {
  if (ms < 0) {
    out.trace = REVEAL_HIDDEN.trace
    out.gridMs = REVEAL_HIDDEN.gridMs
    out.tint = REVEAL_HIDDEN.tint
    return out
  }
  if (ms >= REVEAL_END_MS) {
    out.trace = REVEAL_SETTLED.trace
    out.gridMs = REVEAL_SETTLED.gridMs
    out.tint = REVEAL_SETTLED.tint
    return out
  }
  out.trace = easeInOut(Math.min(1, ms / REVEAL_TRACE_MS))
  out.gridMs = ms - REVEAL_TRACE_MS - REVEAL_GRID_AFTER_MS
  const h = (ms - REVEAL_TRACE_MS) / 420
  const swell = h <= 0 ? 0 : h < 0.3 ? h / 0.3 : Math.max(0.45, 1 - (h - 0.3) * 0.8)
  const fadeFrom = REVEAL_END_MS - 420
  out.tint = ms < fadeFrom ? swell : swell * (1 - (ms - fadeFrom) / 420)
  return out
}

/**
 * The point at `s` (0 to 1) along one half of the plate outline, in plate shader coordinates (x right, y toward the
 * back, mm from the center): from the front middle round the `side` (1 right, -1 left) corners to the back middle.
 * The inverse of `traced` in the plate shader.
 */
export function outlinePoint(s: number, side: 1 | -1, hx: number, hy: number, out: { x: number; y: number }): { x: number; y: number } {
  const d = Math.min(1, Math.max(0, s)) * (2 * hx + 2 * hy)
  if (d <= hx) {
    out.x = d * side
    out.y = -hy
  } else if (d <= hx + 2 * hy) {
    out.x = hx * side
    out.y = d - hx - hy
  } else {
    out.x = (2 * hx + 2 * hy - d) * side
    out.y = hy
  }
  return out
}

/** Window-wide: the reveal plays on the first plate a window shows, not again when a view is rebuilt. */
const played = { done: false }

/** Whether this window has already played the reveal. */
export function revealPlayed(): boolean {
  return played.done
}

/** For tests: forget that the reveal played. */
export function resetRevealPlayed(): void {
  played.done = false
}

/**
 * Runs one reveal. Built when a view decides to play it; `step` is called every frame before the render and returns
 * true while it needs more frames. Everything a frame uses is allocated here, up front.
 */
export class PlateReveal {
  /** When the trace starts (performance.now ms), or null before the plate first shows. */
  private t0: number | null = null
  private hitAt = -1
  private overlay: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private bloom: HTMLCanvasElement | null = null
  private bloomColor = ''
  private ow = 0
  private oh = 0
  private dpr = 1
  private readonly plate: RevealPlate = { trace: -1, gridMs: -1, tint: 0 }
  private readonly raw = new Float32Array((TAIL_POINTS + 1) * 2)
  private readonly pts = new Float32Array((TAIL_POINTS + 1) * 2)
  private readonly sparks = new Float32Array(SPARKS * 2)
  private readonly p = { x: 0, y: 0 }
  private readonly v = new Vector3()
  private hitX = 0
  private hitY = 0
  done = false

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get started(): boolean {
    return this.t0 !== null
  }

  /**
   * One frame. `setPlate` takes the plate's state; `accent` is the theme accent as a CSS color. Plate coordinates are
   * the stage's: the plate quad lies flat at y 0, plate y running toward the back (world -z).
   */
  step(now: number, camera: Camera, hx: number, hy: number, accent: string, setPlate: (trace: number, gridMs: number, tint: number) => void): boolean {
    if (this.done) return false
    if (this.t0 === null) {
      this.t0 = now + REVEAL_DELAY_MS
      played.done = true
    }
    const ms = now - this.t0
    const plate = revealPlate(ms, this.plate)
    setPlate(plate.trace, plate.gridMs, plate.tint)
    if (ms >= REVEAL_END_MS) {
      this.finish(setPlate)
      return false
    }
    this.drawOverlay(ms, camera, hx, hy, accent)
    return true
  }

  /** Ends at once on the settled plate: the reveal was cut short (the view left the plate, or closed). */
  finish(setPlate?: (trace: number, gridMs: number, tint: number) => void): void {
    this.done = true
    setPlate?.(REVEAL_SETTLED.trace, REVEAL_SETTLED.gridMs, REVEAL_SETTLED.tint)
    this.overlay?.remove()
    this.overlay = null
    this.ctx = null
    this.bloom = null
  }

  /** The overlay has work while the crackles run and the bloom and sparks show; after that it is gone. */
  private drawOverlay(ms: number, camera: Camera, hx: number, hy: number, accent: string): void {
    const overlayEnd = REVEAL_TRACE_MS + Math.max(BLOOM_MS, SPARK_MS) + 20
    if (ms < 0) return
    if (ms >= overlayEnd) {
      if (this.overlay) {
        this.overlay.remove()
        this.overlay = null
        this.ctx = null
      }
      return
    }
    const ctx = this.ensureOverlay()
    if (!ctx) return
    ctx.clearRect(0, 0, this.ow, this.oh)
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const dpr = this.dpr
    if (ms < REVEAL_TRACE_MS) {
      const s = easeInOut(ms / REVEAL_TRACE_MS)
      for (const side of SIDES) {
        this.crackle(s, side, camera, hx, hy)
        this.stroke(ctx, TAIL_POINTS + 1, GLOW * dpr, accent, GLOW_ALPHA)
        this.stroke(ctx, TAIL_POINTS + 1, CORE * dpr, '#ffffff', 0.7)
      }
    } else {
      if (this.hitAt < 0) {
        this.hitAt = ms
        this.project(0, hy, camera)
        this.hitX = this.p.x
        this.hitY = this.p.y
        // The sparks fly up and out from the meeting point, away from the plate.
        for (let i = 0; i < SPARKS; i++) {
          this.sparks[i * 2] = Math.PI + Math.random() * Math.PI
          this.sparks[i * 2 + 1] = (26 + Math.random() * 30) * dpr
        }
      }
      const t = ms - this.hitAt
      const k = t / BLOOM_MS
      if (k < 1) {
        const bloom = this.bloomSprite(accent)
        const r = (36 + 140 * k) * dpr
        ctx.globalAlpha = 0.9 * (1 - k) * (1 - k)
        ctx.drawImage(bloom, this.hitX - r, this.hitY - r, r * 2, r * 2)
      }
      const ks = t / SPARK_MS
      if (ks < 1) {
        // Bright specks flying out and fading: an accent streak with a white core, so they read on a pale plate too.
        const fade = 1 - ks
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? accent : '#ffffff'
          ctx.lineWidth = (pass === 0 ? 2.6 : 1.2) * dpr
          ctx.globalAlpha = pass === 0 ? fade : 0.9 * fade
          ctx.beginPath()
          for (let i = 0; i < SPARKS; i++) {
            const a = this.sparks[i * 2]!
            const l = this.sparks[i * 2 + 1]!
            const d1 = l * (1 - (1 - ks) * (1 - ks))
            const d0 = Math.max(0, d1 - 6 * dpr * fade - 2 * dpr)
            const c = Math.cos(a)
            const sn = Math.sin(a)
            ctx.moveTo(this.hitX + c * d0, this.hitY + sn * d0)
            ctx.lineTo(this.hitX + c * d1, this.hitY + sn * d1)
          }
          ctx.stroke()
        }
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  /** A jagged tail behind the head at `s`, in overlay pixels: points along the outline pushed off their screen normal. */
  private crackle(s: number, side: 1 | -1, camera: Camera, hx: number, hy: number): void {
    const raw = this.raw
    const pts = this.pts
    for (let k = 0; k <= TAIL_POINTS; k++) {
      const u = Math.max(0, s - TAIL * (1 - k / TAIL_POINTS))
      outlinePoint(u, side, hx, hy, this.p)
      this.project(this.p.x, this.p.y, camera)
      raw[k * 2] = pts[k * 2] = this.p.x
      raw[k * 2 + 1] = pts[k * 2 + 1] = this.p.y
    }
    // The ends stay on the outline; the jag grows toward the head.
    for (let k = 1; k < TAIL_POINTS; k++) {
      const dx = raw[(k + 1) * 2]! - raw[(k - 1) * 2]!
      const dy = raw[(k + 1) * 2 + 1]! - raw[(k - 1) * 2 + 1]!
      const m = Math.hypot(dx, dy) || 1
      const o = (Math.random() * 2 - 1) * AMP * this.dpr * (k / TAIL_POINTS)
      pts[k * 2] = raw[k * 2]! - (dy / m) * o
      pts[k * 2 + 1] = raw[k * 2 + 1]! + (dx / m) * o
    }
  }

  private stroke(ctx: CanvasRenderingContext2D, n: number, width: number, color: string, alpha: number): void {
    const pts = this.pts
    ctx.beginPath()
    ctx.moveTo(pts[0]!, pts[1]!)
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2]!, pts[i * 2 + 1]!)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }

  /** Plate shader coordinates to overlay pixels, into `this.p`. */
  private project(x: number, y: number, camera: Camera): void {
    const v = this.v.set(x, 0, -y).project(camera)
    this.p.x = (v.x * 0.5 + 0.5) * this.ow
    this.p.y = (-v.y * 0.5 + 0.5) * this.oh
  }

  /** The overlay canvas over the view, sized to it; null when the view has no parent to sit in. */
  private ensureOverlay(): CanvasRenderingContext2D | null {
    const c = this.canvas
    const parent = c.parentElement
    if (!parent || typeof document === 'undefined') return null
    if (!this.overlay) {
      const o = document.createElement('canvas')
      o.setAttribute('aria-hidden', 'true')
      o.dataset['reveal'] = 'overlay'
      o.style.cssText = 'position:absolute;pointer-events:none;z-index:1'
      c.after(o)
      this.overlay = o
      this.ctx = o.getContext('2d')
      this.ow = 0
    }
    const w = c.clientWidth
    const h = c.clientHeight
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    if (this.ow !== Math.round(w * dpr) || this.oh !== Math.round(h * dpr) || this.dpr !== dpr) {
      const o = this.overlay
      this.dpr = dpr
      this.ow = Math.round(w * dpr)
      this.oh = Math.round(h * dpr)
      o.width = this.ow
      o.height = this.oh
      o.style.left = `${c.offsetLeft}px`
      o.style.top = `${c.offsetTop}px`
      o.style.width = `${w}px`
      o.style.height = `${h}px`
    }
    return this.ctx
  }

  /** A soft round accent glow, drawn once and scaled each frame. */
  private bloomSprite(accent: string): HTMLCanvasElement {
    if (this.bloom && this.bloomColor === accent) return this.bloom
    const b = this.bloom ?? document.createElement('canvas')
    b.width = 128
    b.height = 128
    const g = b.getContext('2d')
    if (g) {
      // The accent, faded by an alpha-only mask: a gradient straight to 'transparent' passes through gray, which shows
      // as a dull smudge on a light theme.
      g.globalCompositeOperation = 'source-over'
      g.clearRect(0, 0, 128, 128)
      // A near white core falling off to the accent.
      const color = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      color.addColorStop(0, '#ffffff')
      color.addColorStop(0.22, accent)
      color.addColorStop(1, accent)
      g.fillStyle = color
      g.fillRect(0, 0, 128, 128)
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.35, 'rgba(255,255,255,0.6)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.globalCompositeOperation = 'destination-in'
      g.fillStyle = grad
      g.fillRect(0, 0, 128, 128)
      g.globalCompositeOperation = 'source-over'
    }
    this.bloom = b
    this.bloomColor = accent
    return b
  }
}
