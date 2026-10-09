// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The loading wisp: while a model already drawn is still being checked and loaded, two soft accent wisps run the plate
// edge (the bed's footprint on Model's ground), each a fading ribbon that sheds a few motes outward. It stays on the
// edge, so it never crosses the model, and it is sized to the plate on screen. Under reduced motion the edge holds a
// still, faint glow instead. A 2D overlay over the view with its own frames, so the 3D view never redraws for it.
import { Color, Vector3, type Camera } from 'three'
import { outlinePoint } from './reveal'

/** One lap of the plate edge. */
export const WISP_LAP_MS = 4200
/** Fade in and out. */
export const WISP_FADE_MS = 320
/** The ribbon's length, as a share of the lap. */
const TAIL = 0.26
const TAIL_POINTS = 40
const HEADS = 2
const MOTES = 72
const MOTE_MS = 1000
const MOTES_PER_S = 30

/** Where on the plate outline a point `u` (0 to 1) of the lap is, in plate coordinates; one lap goes round once. */
export function lapPoint(u: number, hx: number, hy: number, out: { x: number; y: number }): { x: number; y: number } {
  const w = ((u % 1) + 1) % 1
  // outlinePoint runs half the outline from the front middle to the back middle on a side; the lap is the right side
  // forward, then the left side back
  return w < 0.5 ? outlinePoint(w * 2, 1, hx, hy, out) : outlinePoint((1 - w) * 2, -1, hx, hy, out)
}

/** How bright the wisp is `ms` after it started (fading in), or after it was told to stop (`stopAt`, fading out). */
export function wispAlpha(ms: number, stopAt: number | null): number {
  const inA = Math.min(1, Math.max(0, ms / WISP_FADE_MS))
  if (stopAt === null) return inA
  return inA * Math.max(0, 1 - (ms - stopAt) / WISP_FADE_MS)
}

export class LoadingWisp {
  private overlay: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private t0 = 0
  private stopAt: number | null = null
  private ow = 0
  private oh = 0
  private dpr = 1
  private lastEmit = 0
  private readonly v = new Vector3()
  private readonly p = { x: 0, y: 0 }
  private readonly pts = new Float32Array((TAIL_POINTS + 1) * 2)
  // motes: x, y, vx, vy, born (ms), size; px in overlay pixels
  private readonly motes = new Float32Array(MOTES * 6)
  private nextMote = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: () => { camera: Camera; hx: number; hy: number; accent: string; still: boolean; light: boolean },
  ) {}

  get running(): boolean {
    return this.raf !== 0
  }

  start(): void {
    if (typeof requestAnimationFrame === 'undefined') return
    if (this.raf && this.stopAt === null) return
    const now = performance.now()
    // a stop under way turns back into a run without a second fade in
    if (this.raf && this.stopAt !== null) {
      const a = wispAlpha(now - this.t0, this.stopAt)
      this.t0 = now - a * WISP_FADE_MS
      this.stopAt = null
      return
    }
    this.t0 = now
    this.stopAt = null
    this.lastEmit = 0
    this.motes.fill(-1e9)
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Fades out, then takes the overlay away. */
  stop(): void {
    if (!this.raf || this.stopAt !== null) return
    this.stopAt = performance.now() - this.t0
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.overlay?.remove()
    this.overlay = null
    this.ctx = null
  }

  private readonly tick = (now: number): void => {
    const ms = now - this.t0
    const alpha = wispAlpha(ms, this.stopAt)
    if (this.stopAt !== null && alpha <= 0) return this.dispose()
    this.draw(ms, alpha)
    this.raf = requestAnimationFrame(this.tick)
  }

  private draw(ms: number, alpha: number): void {
    const ctx = this.ensureOverlay()
    if (!ctx) return
    const { camera, hx, hy, accent, still, light } = this.view()
    ctx.clearRect(0, 0, this.ow, this.oh)
    // on a dark studio the light adds up; on a light one adding would wash out to white, so it paints over
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // sized to the plate on screen: a plate filling the view gets the full width, a small one a thinner wisp
    this.project(-hx, -hy, camera)
    const ax = this.p.x
    const ay = this.p.y
    this.project(hx, hy, camera)
    const k = Math.min(1.4, Math.max(0.55, Math.hypot(this.p.x - ax, this.p.y - ay) / (900 * this.dpr)))
    const unit = this.dpr * k
    if (still) {
      // reduced motion: the whole edge glows faintly and keeps still
      this.path(0, 1, 96, hx, hy, camera)
      this.stroke(ctx, 97, 14 * unit, accent, (light ? 0.08 : 0.12) * alpha)
      this.stroke(ctx, 97, 2.2 * unit, accent, 0.6 * alpha)
      ctx.globalCompositeOperation = 'source-over'
      return
    }
    const lap = ms / WISP_LAP_MS
    const shed = ms - this.lastEmit >= 1000 / MOTES_PER_S
    if (shed) this.lastEmit = ms
    for (let h = 0; h < HEADS; h++) {
      const head = lap + h / HEADS
      this.path(head - TAIL, head, TAIL_POINTS, hx, hy, camera)
      // the ribbon: drawn segment by segment, wider and brighter toward the head
      for (let i = 0; i < TAIL_POINTS; i++) {
        const f = (i + 1) / TAIL_POINTS
        const ease = f * f
        this.segment(ctx, i, 26 * unit * (0.3 + 0.7 * f), accent, (light ? 0.13 : 0.15) * ease * alpha)
        this.segment(ctx, i, 7 * unit * (0.25 + 0.75 * f), accent, (light ? 0.5 : 0.42) * ease * alpha)
        this.segment(ctx, i, (light ? 3.4 : 2.8) * unit * (0.3 + 0.7 * f), accent, 0.95 * Math.sqrt(ease) * alpha)
        if (!light) this.segment(ctx, i, 1.3 * unit * f, '#ffffff', 0.85 * ease * ease * alpha)
      }
      // a soft glow round the head
      const hp = this.cur
      const hxs = hp[TAIL_POINTS * 2]!
      const hys = hp[TAIL_POINTS * 2 + 1]!
      const r = 20 * unit
      const g = ctx.createRadialGradient(hxs, hys, 0, hxs, hys, r)
      g.addColorStop(0, accent)
      g.addColorStop(1, 'transparent')
      ctx.globalAlpha = (light ? 0.42 : 0.45) * alpha
      ctx.fillStyle = g
      ctx.fillRect(hxs - r, hys - r, r * 2, r * 2)
      if (shed) this.emit(ms, head, hx, hy, camera, unit)
    }
    this.drawMotes(ctx, ms, accent, alpha)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  /** Motes shed from the heads, drifting outward from the plate and fading. */
  private emit(ms: number, head: number, hx: number, hy: number, camera: Camera, unit: number): void {
    lapPoint(head, hx, hy, this.p)
    const px = this.p.x
    const py = this.p.y
    // outward in plate coordinates, then both points to the screen
    const len = Math.hypot(px, py) || 1
    this.project(px, py, camera)
    const sx = this.p.x
    const sy = this.p.y
    this.project(px + (px / len) * 6, py + (py / len) * 6, camera)
    const dx = this.p.x - sx
    const dy = this.p.y - sy
    const dl = Math.hypot(dx, dy) || 1
    const m = this.motes
    const i = this.nextMote * 6
    this.nextMote = (this.nextMote + 1) % MOTES
    const speed = (14 + Math.random() * 18) * unit
    const spread = (Math.random() - 0.5) * 0.9
    m[i] = sx
    m[i + 1] = sy
    m[i + 2] = ((dx / dl) * Math.cos(spread) - (dy / dl) * Math.sin(spread)) * speed
    m[i + 3] = ((dx / dl) * Math.sin(spread) + (dy / dl) * Math.cos(spread)) * speed - 8 * unit
    m[i + 4] = ms
    m[i + 5] = (1.4 + Math.random() * 2) * unit
  }

  private drawMotes(ctx: CanvasRenderingContext2D, ms: number, accent: string, alpha: number): void {
    const m = this.motes
    ctx.fillStyle = accent
    for (let i = 0; i < MOTES; i++) {
      const age = ms - m[i * 6 + 4]!
      if (age < 0 || age > MOTE_MS) continue
      const t = age / MOTE_MS
      const s = age / 1000
      const x = m[i * 6]! + m[i * 6 + 2]! * s
      const y = m[i * 6 + 1]! + m[i * 6 + 3]! * s
      ctx.globalAlpha = 0.9 * (1 - t) * (1 - t) * alpha
      ctx.beginPath()
      ctx.arc(x, y, m[i * 6 + 5]! * (1 - 0.5 * t), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Points from lap position `a` to `b`, `n` steps, projected into `this.pts`. */
  private path(a: number, b: number, n: number, hx: number, hy: number, camera: Camera): void {
    const pts = n + 1 > TAIL_POINTS + 1 ? (this.wide ??= new Float32Array((n + 1) * 2)) : this.pts
    for (let k = 0; k <= n; k++) {
      lapPoint(a + ((b - a) * k) / n, hx, hy, this.p)
      this.project(this.p.x, this.p.y, camera)
      pts[k * 2] = this.p.x
      pts[k * 2 + 1] = this.p.y
    }
    this.cur = pts
  }

  private wide: Float32Array | null = null
  private cur: Float32Array = this.pts

  private segment(ctx: CanvasRenderingContext2D, i: number, width: number, color: string, alpha: number): void {
    const p = this.cur
    ctx.beginPath()
    ctx.moveTo(p[i * 2]!, p[i * 2 + 1]!)
    ctx.lineTo(p[(i + 1) * 2]!, p[(i + 1) * 2 + 1]!)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }

  private stroke(ctx: CanvasRenderingContext2D, n: number, width: number, color: string, alpha: number): void {
    const p = this.cur
    ctx.beginPath()
    ctx.moveTo(p[0]!, p[1]!)
    for (let i = 1; i < n; i++) ctx.lineTo(p[i * 2]!, p[i * 2 + 1]!)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }

  /** Plate coordinates to overlay pixels, into `this.p`. */
  private project(x: number, y: number, camera: Camera): void {
    const v = this.v.set(x, 0, -y).project(camera)
    this.p.x = (v.x * 0.5 + 0.5) * this.ow
    this.p.y = (-v.y * 0.5 + 0.5) * this.oh
  }

  private ensureOverlay(): CanvasRenderingContext2D | null {
    const c = this.canvas
    if (!c.parentElement || typeof document === 'undefined') return null
    if (!this.overlay) {
      const o = document.createElement('canvas')
      o.setAttribute('aria-hidden', 'true')
      o.dataset['wisp'] = 'overlay'
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
}

/** A light studio (its top color more than half bright), where the wisp paints over instead of adding light. */
export function lightStudio(bgTop: string): boolean {
  const c = new Color(bgTop)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.5
}
