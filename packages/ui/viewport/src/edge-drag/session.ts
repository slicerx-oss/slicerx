// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag while a part moves: each plate edge shows a band in the space off the bed, with a chevron and the
// plate it adds to, and the band glows stronger the further the part goes out. Once the whole part (or group) is past
// the commit line the line turns solid and the label underlined; a release there drops it into the plate bar and the
// view follows it to its new plate (with no plate bar on screen, as on a phone, the plate shows at once in the same
// framing and a short note says where it went). A finger's drag also slides the view toward the side it heads for, so
// the line arms in sight. A release short of the line, Esc or a lost pointer puts it back. Loaded on the
// first part drag (index.ts); the overlay exists only while a part moves and is gone again after the drop. The host
// owns the plates: it lists them, moves the parts and shows the plate after (EdgeDragOptions).
import type { EdgeDragInfo } from '../types'
import { countOverlay, hintShown, type EdgeDragDestination, type EdgeDragOptions, type EdgeDragViewport } from './index'
import { overlayInsets } from './insets'
import { DEFAULT_EDGE_DRAG_LABELS, type EdgeDragLabels } from './labels'
import { applyEdgeDragTheme, injectEdgeDragStyle } from './style'
import { armedMessage, BED_EDGES, commitMarginMm, edgeReach, fitScale, glow, pulse, readEdges, reachPastLineMm, roomNeeded, sidesOf, sideTargets, targetLabel, visibleArea, type BedEdge, type Box2, type EdgeRead, type EdgeTarget, type PlateRef, type ScreenRect, type Side } from './geometry'

export interface EdgeSession {
  reachMm(): number
  move(e: EdgeDragInfo): void
  end(e: EdgeDragInfo & { onBed: boolean }): 'commit' | 'back'
  cancel(): void
}

type P = [number, number]

/** A touch drag eases the view out to this, so a part has room to leave the bed sideways. */
export const TOUCH_ZOOM = 0.72
export const TOUCH_ZOOM_MS = 240
/** The furthest a drag eases the view out to give every edge its room. */
export const MIN_DRAG_ZOOM = 0.45
/** How far a finger's part goes (mm) before the side it heads for is known, and the view slides to give it the room. */
export const HEADING_MM = 2
/** Room a finger's armed part keeps from the edges of what a person can see, px. */
const PART_ROOM_PX = 24
/** How far inside the screen the finger stays when the part arms: the outer strip is the screen's own edge swipes. */
const FINGER_CLEAR_PX = 40
/** The least drag a finger still makes to the line after the view slides, so the line never arms by itself. */
const MIN_TRAVEL_PX = 48
/** How long a part waits past the More plates line before the list opens, ms. */
export const MORE_DWELL_MS = 300
const DROP_MS = 460
const RING_MS = 520
const HINT_MS = 1800
const SVG = 'http://www.w3.org/2000/svg'

const OUT: Record<BedEdge, P> = { 'x-': [-1, 0], 'x+': [1, 0], 'y-': [0, -1], 'y+': [0, 1] }
const SIDE_ANGLE: Record<Side, number> = { right: 0, bottom: 90, left: 180, top: 270 }

/** Whether motion is reduced: the app's own setting, else the system's. */
export function motionReduced(): boolean {
  const m = typeof document === 'undefined' ? undefined : document.documentElement.dataset['motion']
  if (m) return m === 'reduced'
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}


interface EdgeGeo {
  edge: BedEdge
  side: Side
  a: P
  b: P
  mid: P
  n: P
  /** The commit line, on screen. */
  line: [P, P]
  margin: number
  reachPast: number
  /** Millimeters per screen pixel across this edge. */
  k: number
  depth: number
}

interface SideEls {
  band: SVGPolygonElement
  stop: SVGLinearGradientElement
  edgeLine: SVGLineElement
  commit: SVGLineElement
  /** Halos under the two lines, so each keeps its contrast over the band, the bed and the view behind. */
  edgeHalo: SVGLineElement
  commitHalo: SVGLineElement
  label: HTMLDivElement
  text: HTMLSpanElement
  /** The chevron's path, turned so it points out of the bed on screen even when its label runs along a side. */
  chev: SVGPathElement
}

const place = (ln: SVGLineElement, a: P, b: P): void => {
  ln.setAttribute('x1', a[0].toFixed(1))
  ln.setAttribute('y1', a[1].toFixed(1))
  ln.setAttribute('x2', b[0].toFixed(1))
  ln.setAttribute('y2', b[1].toFixed(1))
}
const add = (a: P, b: P, k = 1): P => [a[0] + b[0] * k, a[1] + b[1] * k]
const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v))
const pts = (ps: readonly P[]): string => ps.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function htmlEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

/** A chevron pointing `angle` degrees (0 right, 90 down), as the band's label carries. */
function chevron(angle: number): SVGSVGElement {
  const s = svgEl('svg', { viewBox: '-7 -7 14 14', class: 'sx-edge-chev', 'aria-hidden': 'true' })
  s.appendChild(svgEl('path', { d: 'M-5 -5 L0 0 L-5 5 M1 -5 L6 0 L1 5', transform: `rotate(${angle})` }))
  return s
}

/** How far a ray from `p` along `n` runs before it leaves a w by h box. */
function room(p: P, n: P, w: number, h: number): number {
  let t = Infinity
  if (n[0] > 1e-6) t = Math.min(t, (w - p[0]) / n[0])
  if (n[0] < -1e-6) t = Math.min(t, -p[0] / n[0])
  if (n[1] > 1e-6) t = Math.min(t, (h - p[1]) / n[1])
  if (n[1] < -1e-6) t = Math.min(t, -p[1] / n[1])
  return Number.isFinite(t) ? Math.max(0, t) : 0
}

export function startEdgeSession(o: { viewport: EdgeDragViewport; stage: HTMLElement; options: EdgeDragOptions; first: EdgeDragInfo }): EdgeSession {
  const { stage, options: host } = o
  const view = o.viewport
  const screenOf = (p: [number, number, number]): [number, number] | null => view.screenOf?.(p) ?? null
  const bed = o.first.bed
  const labels: EdgeDragLabels = { ...DEFAULT_EDGE_DRAG_LABELS, ...host.labels }
  const platesBefore = host.plates()
  const targets = sideTargets(platesBefore, host.activePlate())
  const reduced = motionReduced()
  const touch = o.first.pointerType === 'touch'
  let info = o.first
  let live = true
  let raf = 0
  let t0 = performance.now()
  let geo: Record<BedEdge, EdgeGeo> | null = null
  let read: EdgeRead = { edge: null, armed: false, lead: 0, trail: 0, size: 0, margin: 0 }
  let said = ''
  let more: { el: HTMLDivElement; rows: { el: HTMLDivElement; plate: PlateRef }[]; hot: PlateRef | null } | null = null
  let dwell: ReturnType<typeof setTimeout> | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()

  // ---------- the overlay, built once for this move ----------
  const root = htmlEl('div', 'sx-edge-drag')
  root.setAttribute('data-testid', 'edge-drag')
  const bands = htmlEl('div', 'sx-edge-bands')
  const svg = svgEl('svg', { class: 'sx-edge-svg', 'aria-hidden': 'true' })
  const defs = svgEl('defs')
  svg.appendChild(defs)
  bands.appendChild(svg)
  root.appendChild(bands)
  const liveEl = htmlEl('div', 'sr-only')
  liveEl.setAttribute('role', 'status')
  liveEl.setAttribute('aria-live', 'polite')
  liveEl.setAttribute('data-testid', 'edge-drag-live')
  root.appendChild(liveEl)
  const els: Partial<Record<Side, SideEls>> = {}
  const uid = Math.random().toString(36).slice(2, 8)
  for (const side of ['left', 'top', 'right', 'bottom'] as const) {
    const t = targets[side]
    if (!t) continue
    const grad = svgEl('linearGradient', { id: `sx-edge-g-${uid}-${side}`, gradientUnits: 'userSpaceOnUse' })
    grad.appendChild(svgEl('stop', { offset: 0, class: 'sx-edge-stop', 'stop-opacity': 0.75 }))
    grad.appendChild(svgEl('stop', { offset: 0.55, class: 'sx-edge-stop', 'stop-opacity': 0.22 }))
    grad.appendChild(svgEl('stop', { offset: 1, class: 'sx-edge-stop', 'stop-opacity': 0 }))
    defs.appendChild(grad)
    const band = svgEl('polygon', { class: 'sx-edge-band', fill: `url(#sx-edge-g-${uid}-${side})` })
    const edgeHalo = svgEl('line', { class: 'sx-edge-halo' })
    const edgeLine = svgEl('line', { class: 'sx-edge-line' })
    const commitHalo = svgEl('line', { class: 'sx-edge-halo sx-edge-commit-halo' })
    const commit = svgEl('line', { class: 'sx-edge-commit' })
    svg.append(band, edgeHalo, edgeLine, commitHalo, commit)
    const label = htmlEl('div', 'sx-edge-label')
    label.dataset['side'] = side
    label.setAttribute('data-testid', `edge-drag-${side}`)
    const text = htmlEl('span', 'sx-edge-text', targetLabel(t, labels))
    const chev = chevron(SIDE_ANGLE[side])
    // the chevron sits on the outward end: after the text on the right, before it elsewhere
    if (side === 'right') label.append(text, chev)
    else label.append(chev, text)
    bands.appendChild(label)
    els[side] = { band, stop: grad, edgeLine, commit, edgeHalo, commitHalo, label, text, chev: chev.querySelector('path')! }
  }
  applyEdgeDragTheme(root, host.theme)
  if (stage.getBoundingClientRect().width < 600) root.setAttribute('data-compact', '')
  injectEdgeDragStyle(stage.ownerDocument)
  stage.appendChild(root)
  countOverlay(1)

  // ---------- geometry ----------
  const measure = (): Record<BedEdge, EdgeGeo> | null => {
    const r = stage.getBoundingClientRect()
    if (!r.width || !r.height) return null
    const at = (x: number, y: number): P => {
      const c = screenOf([x, y, 0]) ?? [Number.NaN, Number.NaN]
      return [c[0] - r.left, c[1] - r.top]
    }
    const W = bed.widthMm
    const D = bed.depthMm
    const ends: Record<BedEdge, [P, P]> = { 'x-': [[0, 0], [0, D]], 'x+': [[W, 0], [W, D]], 'y-': [[0, 0], [W, 0]], 'y+': [[0, D], [W, D]] }
    const raw = {} as Record<BedEdge, Omit<EdgeGeo, 'side' | 'depth'>>
    const outward = {} as Record<BedEdge, P>
    for (const e of BED_EDGES) {
      const [p, q] = ends[e]
      const d = OUT[e]
      const midMm: P = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
      const mid = at(midMm[0], midMm[1])
      const off = at(midMm[0] + d[0] * 10, midMm[1] + d[1] * 10)
      const len = Math.hypot(off[0] - mid[0], off[1] - mid[1])
      if (!(len > 1e-6) || !Number.isFinite(len) || !Number.isFinite(mid[0] + mid[1])) return null
      const n: P = [(off[0] - mid[0]) / len, (off[1] - mid[1]) / len]
      const k = 10 / len
      const margin = commitMarginMm(k)
      outward[e] = n
      raw[e] = { edge: e, a: at(p[0], p[1]), b: at(q[0], q[1]), mid, n, margin, k, reachPast: reachPastLineMm(k), line: [at(p[0] + d[0] * margin, p[1] + d[1] * margin), at(q[0] + d[0] * margin, q[1] + d[1] * margin)] }
    }
    const sides = sidesOf(outward)
    const compact = r.width < 600
    const out = {} as Record<BedEdge, EdgeGeo>
    for (const e of BED_EDGES) {
      const side = sides[e]
      const max = compact ? (side === 'left' || side === 'right' ? 87 : 140) : side === 'left' || side === 'right' ? 190 : side === 'top' ? 108 : 112
      out[e] = { ...raw[e], side, depth: clamp(room(raw[e].mid, raw[e].n, r.width, r.height) - 4, 36, max) }
    }
    return out
  }

  const offered = (g: Record<BedEdge, EdgeGeo>): BedEdge[] => BED_EDGES.filter((e) => targets[g[e].side])
  const margins = (g: Record<BedEdge, EdgeGeo>): Record<BedEdge, number> => ({ 'x-': g['x-'].margin, 'x+': g['x+'].margin, 'y-': g['y-'].margin, 'y+': g['y+'].margin })

  /** The footprint's corners on screen, for the drop and for keeping a label clear of the part. */
  const screenBox = (box: Box2): { x0: number; y0: number; x1: number; y1: number } | null => {
    const r = stage.getBoundingClientRect()
    const cs: P[] = [
      [box.min[0], box.min[1]],
      [box.max[0], box.min[1]],
      [box.max[0], box.max[1]],
      [box.min[0], box.max[1]],
    ].map(([x, y]) => {
      const c = screenOf([x!, y!, 0]) ?? [Number.NaN, Number.NaN]
      return [c[0] - r.left, c[1] - r.top]
    })
    if (cs.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) return null
    return { x0: Math.min(...cs.map((c) => c[0])), y0: Math.min(...cs.map((c) => c[1])), x1: Math.max(...cs.map((c) => c[0])), y1: Math.max(...cs.map((c) => c[1])) }
  }

  const activeTarget = (): EdgeTarget | null => (read.edge && geo ? (targets[geo[read.edge].side] ?? null) : null)

  // ---------- room ----------
  let zoom = 1
  /** What a person can see of the view, in the overlay's own pixels: the view in the window, less the bars over it. */
  const visible = (): ScreenRect => {
    const r = stage.getBoundingClientRect()
    const bars = host.obstacles?.() ?? []
    const v = visibleArea(r, { width: window.innerWidth, height: window.innerHeight }, overlayInsets(r, bars))
    return { left: v.left - r.left, top: v.top - r.top, right: v.right - r.left, bottom: v.bottom - r.top }
  }
  /** The scale from here that gives every offered edge its room. */
  const fit = (): number => {
    const g = measure()
    if (!g) return 1
    const r = stage.getBoundingClientRect()
    const c = screenOf([bed.widthMm / 2, bed.depthMm / 2, 0])
    if (!c) return 1
    // a drag may take the part as far past any edge as the furthest edge allows (the view gets one reach for all)
    const reach = Math.max(...BED_EDGES.map((e) => g[e].margin + g[e].reachPast))
    const edges = offered(g).map((e) => ({ mid: g[e].mid, n: g[e].n, need: roomNeeded(edgeReach(info.box, bed, e).size, reach, g[e].k, 24) }))
    return fitScale(visible(), [c[0] - r.left, c[1] - r.top], edges, MIN_DRAG_ZOOM)
  }
  /** The slide a finger's drag adds to the zoom (setDragZoom's shift), px, and until when the view is still easing. */
  let shift: P = [0, 0]
  let easing = 0
  const ease = (): void => {
    easing = performance.now() + TOUCH_ZOOM_MS + 48
    root.dataset['zoom'] = zoom.toFixed(3)
    root.dataset['shift'] = `${Math.round(shift[0])},${Math.round(shift[1])}`
  }
  const zoomTo = (scale: number): void => {
    if (!(scale < 0.995) || Math.abs(scale - zoom) < 0.005) return
    zoom = scale
    if (touch) view.setDragZoom?.(scale, TOUCH_ZOOM_MS, shift)
    else view.setDragZoom?.(scale, TOUCH_ZOOM_MS)
    ease()
  }
  const center = (b: Box2): P => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  /** The offered edge a part is heading out over, from its way since the drag started; null until it has gone a little. */
  const heading = (g: Record<BedEdge, EdgeGeo>): BedEdge | null => {
    const a = center(o.first.box)
    const b = center(info.box)
    const v: P = [b[0] - a[0], b[1] - a[1]]
    const len = Math.hypot(v[0], v[1])
    if (len < HEADING_MM) return null
    let best: BedEdge | null = null
    let most = Math.SQRT1_2
    for (const e of offered(g)) {
      const c = (v[0] * OUT[e][0] + v[1] * OUT[e][1]) / len
      if (c > most) {
        most = c
        best = e
      }
    }
    return best
  }
  /** A part moved out over edge `e` until its near side is `trail` mm past it, on screen. */
  const outTo = (e: BedEdge, trail: number): { x0: number; y0: number; x1: number; y1: number } | null => {
    const d = OUT[e]
    const m = trail - edgeReach(info.box, bed, e).trail
    return screenBox({ min: [info.box.min[0] + d[0] * m, info.box.min[1] + d[1] * m], max: [info.box.max[0] + d[0] * m, info.box.max[1] + d[1] * m] })
  }
  /** The finger less the middle of its part on screen, from the last move with the view at rest. */
  let grab: P | null = null
  const grabOf = (): void => {
    const b = screenBox(info.box)
    const r = stage.getBoundingClientRect()
    if (b) grab = [info.client[0] - r.left - (b.x0 + b.x1) / 2, info.client[1] - r.top - (b.y0 + b.y1) / 2]
  }
  /** How far a finger's drag may take the part past the edge it heads for, mm, or null for the usual reach. */
  let touchReach: number | null = null
  /**
   * A phone's view, eased out as far as the bed stays readable, can still leave a side too little room: the line arms
   * with the part half off screen, or only with the finger in the screen's edge strip. So once a finger's part heads for
   * a side, the view slides away from that side until the part, armed, is all in what a person can see with 24 px to
   * spare (in the view less the host's bars, as the desktop's room is measured) and the finger, where it will be when it
   * arms, is a thumb's width inside the screen. The slide always leaves a deliberate stretch of drag before the line.
   * Past the line the drag then goes only as far as stays in sight. It measures the view as it is, once it has stopped
   * easing, and slides again until it fits.
   */
  const slide = (g: Record<BedEdge, EdgeGeo>): void => {
    // the ease is timed on performance.now(), the clock a frame's own time need not share (jsdom's frames start at the
    // window's creation), so the check reads that clock and not the frame's
    if (!touch || performance.now() < easing) return
    const e = heading(g)
    if (!e) {
      touchReach = null
      return
    }
    const eg = g[e]
    const r = stage.getBoundingClientRect()
    const vis = visible()
    const seen = { left: Math.max(0, -r.left), top: Math.max(0, -r.top), right: Math.min(r.width, window.innerWidth - r.left), bottom: Math.min(r.height, window.innerHeight - r.top) }
    const armed = outTo(e, eg.margin)
    if (!grab || !armed) return
    // the part keeps to the finger: where the finger will be when the part reaches the line, and how far that is
    const finger: P = [(armed.x0 + armed.x1) / 2 + grab[0], (armed.y0 + armed.y1) / 2 + grab[1]]
    const toLine = (finger[0] - (info.client[0] - r.left)) * eg.n[0] + (finger[1] - (info.client[1] - r.top)) * eg.n[1]
    const over = (lo: number, hi: number, a: number, b: number, pad: number): number => (hi + pad > b ? hi + pad - b : lo - pad < a ? lo - pad - a : 0)
    const larger = (p: number, q: number): number => (Math.abs(p) >= Math.abs(q) ? p : q)
    const ox = larger(over(armed.x0, armed.x1, vis.left, vis.right, PART_ROOM_PX), over(finger[0], finger[0], seen.left, seen.right, FINGER_CLEAR_PX))
    const oy = larger(over(armed.y0, armed.y1, vis.top, vis.bottom, PART_ROOM_PX), over(finger[1], finger[1], seen.top, seen.bottom, FINGER_CLEAR_PX))
    if (view.setDragZoom && (Math.abs(ox) >= 4 || Math.abs(oy) >= 4)) {
      let dx = -ox
      let dy = -oy
      // a slide takes its length off the drag to the line (the part keeps to the finger, so the bed comes to it)
      const along = -(dx * eg.n[0] + dy * eg.n[1])
      const allowed = Math.max(0, toLine - MIN_TRAVEL_PX)
      if (along > allowed) {
        dx *= allowed / along
        dy *= allowed / along
      }
      // never more than half the view: the bed stays in sight on the other side
      const next: P = [clamp(shift[0] + dx, -(vis.right - vis.left) / 2, (vis.right - vis.left) / 2), clamp(shift[1] + dy, -(vis.bottom - vis.top) / 2, (vis.bottom - vis.top) / 2)]
      if (Math.abs(next[0] - shift[0]) >= 4 || Math.abs(next[1] - shift[1]) >= 4) {
        shift = next
        if (zoom >= 0.995) zoom = 1
        view.setDragZoom(zoom, TOUCH_ZOOM_MS, shift)
        ease()
        return
      }
    }
    // past the line, only as far as the part stays in sight (and never short of the line); the footprint leaves out
    // the part's height on screen, so it keeps half the armed part's room
    const full = Math.max(...BED_EDGES.map((x) => g[x].margin + g[x].reachPast))
    const pad = PART_ROOM_PX / 2
    const fits = (t: number): boolean => {
      const b = outTo(e, t)
      return !!b && b.x0 - pad >= vis.left && b.x1 + pad <= vis.right && b.y0 - pad >= vis.top && b.y1 + pad <= vis.bottom
    }
    let lo = eg.margin
    let hi = full
    if (fits(hi)) lo = hi
    else for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    touchReach = lo
  }
  let readoutAt = ''
  /** Keeps the view's move readout on the far side of the part from the edge it goes out over, clear of the labels. */
  const nudgeReadout = (g: Record<BedEdge, EdgeGeo>, part: { x0: number; y0: number; x1: number; y1: number } | null, r: DOMRect): void => {
    if (!view.placeReadout || !part) return
    let edge: BedEdge | null = read.edge
    if (!edge) {
      // heading for an edge: the one the part is nearest to going over, within its own size
      let lead = -Infinity
      for (const e of offered(g)) {
        const x = edgeReach(info.box, bed, e)
        if (x.lead > -x.size && x.lead > lead) {
          lead = x.lead
          edge = e
        }
      }
    }
    if (!edge) return
    const n = g[edge].n
    const cx = (part.x0 + part.x1) / 2
    const cy = (part.y0 + part.y1) / 2
    const ext = Math.abs(n[0]) * (part.x1 - part.x0) / 2 + Math.abs(n[1]) * (part.y1 - part.y0) / 2 + (touch ? 72 : 40)
    const vis = visible()
    const x = clamp(cx - n[0] * ext - 45, vis.left + 4, Math.max(vis.left + 4, vis.right - 94))
    const y = clamp(cy - n[1] * ext - 11, vis.top + 4, Math.max(vis.top + 4, vis.bottom - 26))
    const key = `${Math.round(x)},${Math.round(y)}`
    if (key === readoutAt) return
    readoutAt = key
    view.placeReadout(x + r.left, y + r.top)
  }

  // ---------- drawing ----------
  const say = (text: string): void => {
    if (text === said) return
    said = text
    liveEl.textContent = text
  }

  const draw = (now: number): void => {
    geo = measure()
    if (!geo) return
    const g = geo
    read = readEdges(info.box, bed, offered(g), margins(g))
    slide(g)
    const part = screenBox(info.box)
    const view = stage.getBoundingClientRect()
    // the part of the stage that is on screen: the stage can run past the window's edge on a phone
    const seen = { x0: Math.max(0, -view.left), y0: Math.max(0, -view.top), x1: Math.min(view.width, window.innerWidth - view.left), y1: Math.min(view.height, window.innerHeight - view.top) }
    const t = (now - t0) / 1000
    // what a label keeps off: the part as drawn (its footprint, raised by about its own height, and room for its move
    // arrows) and the view's move readout beside the pointer
    const keepOff: { x0: number; y0: number; x1: number; y1: number }[] = []
    // a finger moves the part by its arrows, which reach about 64 px out from it
    const pad = touch ? 48 : 20
    if (part) keepOff.push({ x0: part.x0 - pad, y0: part.y0 - pad - Math.max(24, part.y1 - part.y0), x1: part.x1 + pad, y1: part.y1 + pad })
    nudgeReadout(g, part, view)
    const readout = document.querySelector<HTMLElement>('.vp-gizmo-label')
    if (readout && readout.style.display !== 'none' && readout.offsetParent !== null) {
      const g = readout.getBoundingClientRect()
      if (g.width) keepOff.push({ x0: g.left - view.left - 6, y0: g.top - view.top - 6, x1: g.right - view.left + 6, y1: g.bottom - view.top + 6 })
    }
    for (const e of BED_EDGES) {
      const eg = g[e]
      const el = els[eg.side]
      if (!el) continue
      const r = edgeReach(info.box, bed, e)
      const active = read.edge === e
      const armed = active && read.armed
      const gl = glow(r.lead, r.size, eg.margin, armed, eg.reachPast)
      let level = gl.level + (active && !reduced ? pulse(t, r.lead, gl.deep) : 0)
      if (!active && level > 0.99) level = 0.9
      level = clamp(level, 0, 1.2)
      const a0 = clamp(armed ? 0.5 + (level - 1) * 0.6 : 0.07 + 0.34 * level, 0, 0.75)
      const far = add(eg.mid, eg.n, eg.depth)
      el.band.setAttribute('points', pts([eg.a, eg.b, add(eg.b, eg.n, eg.depth), add(eg.a, eg.n, eg.depth)]))
      el.band.style.opacity = (a0 / 0.75).toFixed(3)
      el.stop.setAttribute('x1', eg.mid[0].toFixed(1))
      el.stop.setAttribute('y1', eg.mid[1].toFixed(1))
      el.stop.setAttribute('x2', far[0].toFixed(1))
      el.stop.setAttribute('y2', far[1].toFixed(1))
      const edgeOpacity = clamp(0.2 + 0.7 * level).toFixed(3)
      for (const ln of [el.edgeHalo, el.edgeLine]) {
        place(ln, eg.a, eg.b)
        ln.style.opacity = edgeOpacity
      }
      if (active && r.lead > 0) {
        const o = (armed ? 1 : 0.9 + 0.1 * clamp(r.lead / Math.max(1e-6, r.size + eg.margin))).toFixed(3)
        for (const ln of [el.commitHalo, el.commit]) {
          place(ln, eg.line[0], eg.line[1])
          ln.style.opacity = o
          ln.toggleAttribute('data-armed', armed)
          ln.style.display = ''
        }
      } else {
        el.commit.style.display = 'none'
        el.commitHalo.style.display = 'none'
      }
      // the label: halfway into the band, turned along a side band too narrow for it, always all in sight and clear of
      // the part. It tries its own spot first, then slides along its edge either way, then the other way of laying it.
      const w = el.label.offsetWidth || 140
      const h = el.label.offsetHeight || 20
      const side = eg.side === 'left' || eg.side === 'right'
      const narrow = side && eg.depth < w + 24
      const along: P = [eg.b[0] - eg.a[0], eg.b[1] - eg.a[1]]
      const alen = Math.hypot(along[0], along[1]) || 1
      const u: P = [along[0] / alen, along[1] / alen]
      let best: { c: P; turn: boolean; cost: number } | null = null
      for (const turn of side ? (narrow ? [true, false] : [false, true]) : [false]) {
        const hx = turn ? h / 2 : w / 2
        const hy = turn ? w / 2 : h / 2
        const out = side && !turn ? Math.min(eg.depth * 0.5, 20 + w / 2) : eg.depth * 0.5
        const base = add(eg.mid, eg.n, out)
        for (const step of [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -8, 8]) {
          let c = add(base, u, step * 40)
          c = [clamp(c[0], seen.x0 + hx + 8, Math.max(seen.x0 + hx + 8, seen.x1 - hx - 8)), clamp(c[1], seen.y0 + hy + 8, Math.max(seen.y0 + hy + 8, seen.y1 - hy - 8))]
          let hit = 0
          for (const o of keepOff) hit += Math.max(0, Math.min(c[0] + hx, o.x1) - Math.max(c[0] - hx, o.x0)) * Math.max(0, Math.min(c[1] + hy, o.y1) - Math.max(c[1] - hy, o.y0))
          // a label pushed far from its own edge reads as another edge's: distance from its spot counts a little
          const cost = hit * 100 + Math.hypot(c[0] - base[0], c[1] - base[1]) + (turn !== narrow ? 30 : 0)
          if (!best || cost < best.cost) best = { c, turn, cost }
        }
      }
      const c = best!.c
      const turn = best!.turn
      const spin = turn ? (eg.side === 'left' ? -90 : 90) : 0
      el.label.style.transform = `translate(${c[0].toFixed(1)}px, ${c[1].toFixed(1)}px) translate(-50%, -50%)${spin ? ` rotate(${spin}deg)` : ''}`
      const chevTurn = `rotate(${SIDE_ANGLE[eg.side] - spin})`
      if (el.chev.getAttribute('transform') !== chevTurn) el.chev.setAttribute('transform', chevTurn)
      // never faint: the label keeps its contrast on the bed's surroundings in both themes, and only firms up as it nears
      el.label.style.opacity = clamp(0.8 + 0.2 * level).toFixed(3)
      el.label.toggleAttribute('data-armed', armed)
    }
    drawMore(now)
    const hot = more?.hot
    const target = activeTarget()
    if (hot) say(armedMessage(hot, labels))
    else if (read.armed && target && target.kind !== 'more') say(armedMessage(target, labels))
    else if (read.armed && target?.kind === 'more') say(more ? labels.pickFromList : armedMessage(target, labels))
    else say('')
  }

  // ---------- More plates ----------
  const closeMore = (): void => {
    if (dwell) clearTimeout(dwell)
    dwell = null
    more?.el.remove()
    more = null
  }
  const openMore = (list: readonly PlateRef[]): void => {
    if (more || !geo) return
    const el = htmlEl('div', 'sx-edge-more')
    el.setAttribute('role', 'list')
    el.setAttribute('aria-label', labels.morePlates.replace(/^\+\s*/, ''))
    el.setAttribute('data-testid', 'edge-drag-more')
    const rows = list.map((plate) => {
      const row = htmlEl('div', 'sx-edge-more-row')
      row.setAttribute('role', 'listitem')
      row.dataset['plate'] = plate.id
      row.append(htmlEl('span', 'sx-edge-more-thumb'), htmlEl('span', 'sx-edge-more-name', plate.label))
      el.appendChild(row)
      return { el: row, plate }
    })
    root.appendChild(el)
    // past its label, further out the way the part is going, so the label stays in sight; inside the view
    const r = stage.getBoundingClientRect()
    const side = read.edge ? geo[read.edge].side : 'top'
    const lr = read.edge ? els[side]?.label.getBoundingClientRect() : undefined
    const lb = lr ? { left: lr.left - r.left, right: lr.right - r.left, top: lr.top - r.top, bottom: lr.bottom - r.top } : { left: info.client[0] - r.left, right: info.client[0] - r.left, top: info.client[1] - r.top, bottom: info.client[1] - r.top }
    const w = el.offsetWidth || 168
    const h = el.offsetHeight || rows.length * 32 + 8
    const cx = (lb.left + lb.right) / 2
    const cy = (lb.top + lb.bottom) / 2
    let x = cx - w / 2
    let y = cy - h / 2
    if (side === 'top') y = lb.top - 8 - h
    else if (side === 'bottom') y = lb.bottom + 8
    else if (side === 'left') x = lb.left - 8 - w
    else x = lb.right + 8
    x = clamp(x, 8, Math.max(8, r.width - w - 8))
    y = clamp(y, 8, Math.max(8, r.height - h - 8))
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`
    more = { el, rows, hot: null }
  }
  const drawMore = (now: number): void => {
    void now
    const target = activeTarget()
    const onMore = !!target && target.kind === 'more' && read.armed
    if (more) {
      const box = more.el.getBoundingClientRect()
      const [x, y] = info.client
      const inside = x >= box.left - 8 && x <= box.right + 8 && y >= box.top - 8 && y <= box.bottom + 8
      if (!inside && !onMore) return closeMore()
      let hot: PlateRef | null = null
      for (const row of more.rows) {
        const rb = row.el.getBoundingClientRect()
        const over = x >= rb.left && x <= rb.right && y >= rb.top && y <= rb.bottom
        row.el.toggleAttribute('data-hot', over)
        if (over) hot = row.plate
      }
      more.hot = hot
      return
    }
    if (onMore && target.kind === 'more') {
      // hovering the More label opens it at once; otherwise a short dwell past the line does
      const top = geo ? els[geo[read.edge!].side]?.label.getBoundingClientRect() : undefined
      const [x, y] = info.client
      if (top && x >= top.left && x <= top.right && y >= top.top && y <= top.bottom) openMore(target.plates)
      else if (!dwell) {
        const list = target.plates
        dwell = setTimeout(() => {
          dwell = null
          const now2 = activeTarget()
          if (live && now2?.kind === 'more' && read.armed) {
            openMore(list)
            draw(performance.now())
          }
        }, MORE_DWELL_MS)
      }
    } else if (dwell) {
      clearTimeout(dwell)
      dwell = null
    }
  }

  // ---------- frames, keys and the end ----------
  const tick = (now: number): void => {
    raf = 0
    if (!live) return
    draw(now)
    raf = requestAnimationFrame(tick)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !live) return
    e.preventDefault()
    e.stopPropagation()
    if (!view.cancelDrag?.()) session.cancel()
  }
  window.addEventListener('keydown', onKey, true)
  draw(t0)
  if (touch) grabOf()
  // Room for every offered edge: ease the view out until each has the part, its line and its label past it in what a
  // person can see (a touch drag always gets at least the phone's 72 percent), then check once more where it landed.
  zoomTo(Math.min(touch ? TOUCH_ZOOM : 1, fit()))
  setTimeout(() => {
    if (!live) return
    const more2 = fit()
    if (more2 < 0.98) zoomTo(Math.max(MIN_DRAG_ZOOM, zoom * more2))
  }, TOUCH_ZOOM_MS + 80)
  raf = requestAnimationFrame(tick)

  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }
  /** Stops the frames and the key, and lets go of the zoom: the move is over. */
  const stop = (): void => {
    live = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    closeMore()
    window.removeEventListener('keydown', onKey, true)
    if (zoom < 1 || shift[0] || shift[1]) view.setDragZoom?.(null, TOUCH_ZOOM_MS)
    zoom = 1
    shift = [0, 0]
  }
  let gone = false
  /** Takes the overlay away; nothing of the move is left. */
  const remove = (): void => {
    if (gone) return
    gone = true
    for (const t of timers) clearTimeout(t)
    timers.clear()
    root.remove()
    countOverlay(-1)
  }
  const fadeBands = (): void => {
    bands.setAttribute('data-out', '')
    say('')
  }

  /** The part flies into the plate bar, the bar marks the plate, and then the view follows. */
  const drop = (pill: DOMRect, from: { x0: number; y0: number; x1: number; y1: number } | null, count: number, then: () => void): void => {
    const r = stage.getBoundingClientRect()
    if (reduced || !from || typeof Element.prototype.animate !== 'function') {
      then()
      remove()
      return
    }
    const to: P = [pill.left - r.left + 28, pill.top - r.top + pill.height / 2]
    const fly = htmlEl('div', 'sx-edge-fly')
    const w = Math.max(16, from.x1 - from.x0)
    const h = Math.max(16, from.y1 - from.y0)
    fly.style.width = `${w}px`
    fly.style.height = `${h}px`
    root.appendChild(fly)
    const start: P = [(from.x0 + from.x1) / 2, (from.y0 + from.y1) / 2]
    const ctrl: P = [start[0] + 40, to[1] - 30]
    const frames: Keyframe[] = []
    for (let i = 0; i <= 10; i++) {
      const t = i / 10
      const x = (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * ctrl[0] + t * t * to[0]
      const y = (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * ctrl[1] + t * t * to[1]
      // into the bar it shrinks to a thumbnail
      const sc = 1 + (26 / Math.max(w, h) - 1) * (1 - Math.pow(1 - t, 3))
      frames.push({ transform: `translate(${(x - w / 2).toFixed(1)}px, ${(y - h / 2).toFixed(1)}px) scale(${sc.toFixed(3)})`, opacity: t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1, offset: t })
    }
    fly.animate(frames, { duration: DROP_MS, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'forwards' })
    const ring = htmlEl('div', 'sx-edge-ring')
    ring.style.transform = `translate(${(pill.left - r.left - 3).toFixed(0)}px, ${(pill.top - r.top - 3).toFixed(0)}px)`
    ring.style.width = `${pill.width + 6}px`
    ring.style.height = `${pill.height + 6}px`
    const badge = htmlEl('div', 'sx-edge-badge', `+${count}`)
    badge.style.transform = `translate(${(pill.left - r.left + 40).toFixed(0)}px, ${(pill.top - r.top - 6).toFixed(0)}px)`
    root.append(ring, badge)
    ring.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: DROP_MS + RING_MS, easing: 'ease-out', fill: 'forwards' })
    badge.animate([{ opacity: 0, transform: `${badge.style.transform} scale(.6)` }, { opacity: 0, offset: 0.45 }, { opacity: 1, transform: `${badge.style.transform} scale(1)`, offset: 0.6 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: DROP_MS + RING_MS, fill: 'forwards' })
    later(DROP_MS, then)
    later(DROP_MS + RING_MS, remove)
  }

  /**
   * Where a drop with no plate bar to fly to went ("Moved to Plate 4"): the host's own toast (notify), else a short
   * note low in the view, the way the release hint shows.
   */
  const note = (text: string, plateId: string): void => {
    if (host.notify) {
      host.notify(text, plateId)
      return remove()
    }
    const el = htmlEl('div', 'sx-edge-hint', text)
    el.setAttribute('role', 'status')
    el.setAttribute('data-testid', 'edge-drag-note')
    root.appendChild(el)
    const r = stage.getBoundingClientRect()
    const vis = visible()
    const w = el.offsetWidth || 160
    const h = el.offsetHeight || 32
    const x = clamp((vis.left + vis.right) / 2 - w / 2, 12, Math.max(12, r.width - w - 12))
    const y = clamp(vis.bottom - h - 16, 12, Math.max(12, r.height - h - 12))
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`
    if (!reduced && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: HINT_MS, fill: 'forwards' })
    later(HINT_MS, remove)
  }

  /** The short release hint, once a session, by where the part was let go. */
  const hint = (at: P): void => {
    if (hintShown()) return remove()
    hintShown(true)
    const r = stage.getBoundingClientRect()
    const el = htmlEl('div', 'sx-edge-hint', labels.hint)
    el.setAttribute('role', 'status')
    el.setAttribute('data-testid', 'edge-drag-hint')
    root.appendChild(el)
    const w = el.offsetWidth || 220
    const x = clamp(at[0] - r.left - w / 2, 12, Math.max(12, r.width - w - 12))
    const y = clamp(at[1] - r.top - 72, 12, Math.max(12, r.height - 120))
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`
    if (!reduced && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: HINT_MS, fill: 'forwards' })
    later(HINT_MS, remove)
  }

  const session: EdgeSession = {
    reachMm() {
      if (touchReach !== null) return touchReach
      const g = geo ?? measure()
      if (!g) return commitMarginMm(0) + reachPastLineMm(0)
      return Math.max(...BED_EDGES.map((e) => g[e].margin + g[e].reachPast))
    },
    move(e) {
      if (!live) return
      info = e
      if (touch && performance.now() >= easing) grabOf()
      // the frame loop draws it; reading the footprint now keeps a release right after a move exact
      if (geo) read = readEdges(info.box, bed, offered(geo), margins(geo))
    },
    end(e) {
      if (!live) return 'back'
      info = e
      draw(performance.now())
      const hot = more?.hot ?? null
      const target = activeTarget()
      const armed = read.armed
      stop()
      fadeBands()
      if (e.onBed) {
        remove()
        return 'back'
      }
      let dest: EdgeDragDestination | null = null
      if (hot) dest = { plate: hot.id }
      else if (armed && target?.kind === 'plate') dest = { plate: target.plate.id }
      else if (armed && target?.kind === 'new') dest = 'new'
      const from = screenBox(e.box)
      if (dest) {
        // the view changes plates under the bands, so they go at once; the part's flight is the motion now
        bands.style.display = 'none'
        const ids = [...e.ids]
        const to = dest
        // the plate bar to fly to; a phone shows none, and the plate then shows at once
        const pill = host.dropTarget?.() ?? null
        // with nothing to fly to, the view keeps its framing through the move too (a plate left empty would reframe it)
        const hold = <T,>(run: () => T): T => (!pill && view.keepCamera ? view.keepCamera(run) : run())
        let moved: Promise<string | null>
        try {
          const done = hold(() => host.move(ids, to))
          moved = Promise.resolve(done).then((id) => (typeof id === 'string' ? id : to !== 'new' ? to.plate : (host.plates().find((p) => !platesBefore.some((b) => b.id === p.id))?.id ?? null)))
        } catch (err) {
          moved = Promise.reject(err)
        }
        let landed = !pill
        let plateId: string | null = null
        const show = (): void => {
          if (!landed || !plateId) return
          const id = plateId
          const go = (): void => {
            host.onSwitch?.(id, ids)
            if (host.onSwitch) view.setSelection?.(ids)
          }
          if (pill) return go()
          // nothing marks the plate it went to, so the view keeps its framing (no zoom onto the part), moves sideways
          // to the part if it landed out of sight, and a note says where it went
          hold(go)
          if (host.onSwitch) view.showSelection?.({ animate: !reduced, keepZoom: true })
          const label = host.plates().find((p) => p.id === id)?.label
          if (label) note(labels.movedToPlate(label), id)
          else remove()
        }
        moved.then(
          (id) => {
            plateId = id
            if (!id && !pill) remove()
            show()
          },
          () => {
            if (!pill) remove()
          },
        )
        if (pill)
          drop(pill, from, ids.length, () => {
            landed = true
            show()
          })
        return 'commit'
      }
      // on More plates without a pick the line was reached, so the hint would be wrong
      if (armed && target?.kind === 'more') remove()
      else hint(e.client)
      return 'back'
    },
    cancel() {
      if (!live) return
      stop()
      fadeBands()
      remove()
    },
  }
  return session
}
