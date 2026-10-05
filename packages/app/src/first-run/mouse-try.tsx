// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Try the mouse": a small box on a plate the person can drag, scroll and pinch with the selected
// preset's controls. Every event goes through the viewport's own resolveDrag and resolveWheel, so
// what it does here is what the plate does. Drawn on a 2D canvas; no GPU needed.
import { resolveDrag, resolveWheel, type ControlsMap, type DragAction } from '@slicerx/viewport'

type MouseButtonName = 'left' | 'middle' | 'right'
import { useEffect, useRef, useState } from 'react'

const BUTTONS: readonly MouseButtonName[] = ['left', 'middle', 'right']
const VERB: Record<DragAction, string> = { rotate: 'rotates', pan: 'pans', zoom: 'zooms', none: 'does nothing' }

/** "Left drag rotates. Right drag pans. Wheel zooms to the cursor." */
export function controlsCaption(map: ControlsMap): string {
  const parts: string[] = []
  const plain = BUTTONS.map((b) => [b, map.drags.find((d) => d.button === b && !d.mods && (d.context ?? 'any') !== 'preview')?.action ?? 'none'] as const)
  const groups = new Map<DragAction, MouseButtonName[]>()
  for (const [b, a] of plain) groups.set(a, [...(groups.get(a) ?? []), b])
  for (const [action, buttons] of groups) {
    if (action === 'none') continue
    const names = buttons.map((b, i) => (i === 0 ? b[0]!.toUpperCase() + b.slice(1) : b))
    parts.push(`${names.join(' or ')} drag ${VERB[action]}.`)
  }
  const inverted = map.wheel.invert ? ', inverted' : ''
  parts.push(map.wheel.zoomToCursor ? `Wheel zooms to the cursor${inverted}.` : `Wheel zooms to the center${inverted}.`)
  if (map.trackpad.scroll !== 'zoom') parts.push(`Two-finger scroll ${VERB[map.trackpad.scroll]}.`)
  return parts.join(' ')
}

interface View {
  yaw: number
  pitch: number
  panX: number
  panY: number
  zoom: number
}

// Starts small, like a part on a bed seen from the default camera.
const START: View = { yaw: 0.7, pitch: 0.55, panX: 0, panY: 0, zoom: 0.6 }

type V3 = [number, number, number]

function project(p: V3, v: View, w: number, h: number): [number, number, number] {
  const [x, y, z] = p
  const cy = Math.cos(v.yaw)
  const sy = Math.sin(v.yaw)
  const x1 = x * cy - y * sy
  const y1 = x * sy + y * cy
  const cp = Math.cos(v.pitch)
  const sp = Math.sin(v.pitch)
  const y2 = y1 * cp - z * sp
  const z2 = y1 * sp + z * cp
  const s = Math.min(w, h) * 0.2 * v.zoom
  return [w / 2 + v.panX + x1 * s, h / 2 + v.panY - z2 * s * 0.95 + y2 * s * 0.35, y2]
}

function draw(ctx: CanvasRenderingContext2D, v: View, w: number, h: number): void {
  const css = getComputedStyle(ctx.canvas)
  const line = css.getPropertyValue('--line').trim() || '#44475a'
  const accent = css.getPropertyValue('--accent').trim() || css.getPropertyValue('--purple').trim() || '#bd93f9'
  const fg = css.getPropertyValue('--fg').trim() || '#f8f8f2'
  ctx.clearRect(0, 0, w, h)
  // Plate grid.
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  for (let i = -4; i <= 4; i++) {
    for (const [a, b] of [
      [[i, -4, -1], [i, 4, -1]],
      [[-4, i, -1], [4, i, -1]],
    ] as [V3, V3][]) {
      const p = project(a, v, w, h)
      const q = project(b, v, w, h)
      ctx.beginPath()
      ctx.moveTo(p[0], p[1])
      ctx.lineTo(q[0], q[1])
      ctx.stroke()
    }
  }
  // Box, faces sorted back to front.
  const c: V3[] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ]
  const faces: [number[], number][] = [
    [[0, 1, 2, 3], 0.35], [[4, 5, 6, 7], 1], [[0, 1, 5, 4], 0.7],
    [[1, 2, 6, 5], 0.55], [[2, 3, 7, 6], 0.7], [[3, 0, 4, 7], 0.55],
  ]
  const pts = c.map((p) => project(p, v, w, h))
  const order = faces.map(([f, light]) => ({ f, light, depth: f.reduce((s, i) => s + (pts[i]?.[2] ?? 0), 0) / 4 })).sort((a, b) => b.depth - a.depth)
  for (const { f, light } of order) {
    ctx.beginPath()
    f.forEach((i, k) => {
      const p = pts[i]!
      if (k === 0) ctx.moveTo(p[0], p[1])
      else ctx.lineTo(p[0], p[1])
    })
    ctx.closePath()
    ctx.globalAlpha = 0.25 + light * 0.55
    ctx.fillStyle = accent
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = fg
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
}

/** Fills its parent: the plate of the setup preview window. `paintKey` repaints it when the theme changes. */
export function MouseTry({ map, label, paintKey }: { map: ControlsMap; label: string; paintKey?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ ...START })
  const drag = useRef<{ id: number; x: number; y: number; action: DragAction } | null>(null)
  const space = useRef(false)
  const mapRef = useRef(map)
  const [last, setLast] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  mapRef.current = map

  const repaint = () => {
    const el = ref.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr)
    if (el.height !== Math.round(h * dpr)) el.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(ctx, view.current, w, h)
  }

  const apply = (action: DragAction | 'zoom', dx: number, dy: number) => {
    const v = view.current
    const m = mapRef.current
    if (action === 'rotate') {
      v.yaw += dx * 0.01 * m.rotateSpeed
      v.pitch = Math.max(-0.2, Math.min(1.4, v.pitch + dy * 0.01 * m.rotateSpeed))
    } else if (action === 'pan') {
      v.panX += dx
      v.panY += dy
    } else if (action === 'zoom') {
      v.zoom = Math.max(0.25, Math.min(3, v.zoom * Math.exp(-dy * 0.004 * m.zoomSpeed)))
    }
    repaint()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!el.getContext('2d')) {
      setBroken(true)
      return
    }
    repaint()
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const m = mapRef.current
      const kind = resolveWheel(m, e)
      const sign = m.wheel.invert ? -1 : 1
      if (kind === 'zoom') apply('zoom', 0, e.deltaY * sign * (e.ctrlKey ? 4 : 1))
      else apply(kind, -e.deltaX, -e.deltaY)
      setLast(kind === 'zoom' ? 'Zoom' : kind === 'pan' ? 'Pan' : 'Rotate')
    }
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => repaint())
    ro?.observe(el)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      ro?.disconnect()
    }
    // repaint and apply read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    repaint()
    // A new preset or theme may change the colors; repaint picks them up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, paintKey])

  if (broken) return <p className="fr-try-off">3D preview is not available on this device. Controls still apply.</p>

  const caption = controlsCaption(map)
  const reset = () => {
    view.current = { ...START }
    repaint()
    setLast(null)
  }
  return (
    <div className="fr-try">
      <canvas
        ref={ref}
        className="fr-try-canvas"
        tabIndex={0}
        role="img"
        aria-label={`Try the mouse: ${label}. ${caption} Arrow keys rotate, plus and minus zoom.`}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          const name: MouseButtonName = e.pointerType === 'touch' ? 'left' : (BUTTONS[e.button === 1 ? 1 : e.button === 2 ? 2 : 0] ?? 'left')
          const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, space: space.current }
          const action = resolveDrag(mapRef.current, name, mods, 'prepare')
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, action }
          e.currentTarget.setPointerCapture(e.pointerId)
          setLast(action === 'none' ? 'No action on that button' : action[0]!.toUpperCase() + action.slice(1))
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          d.x = e.clientX
          d.y = e.clientY
          if (d.action !== 'none') apply(d.action, dx, dy)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onKeyDown={(e) => {
          if (e.key === ' ') space.current = true
          const step: Record<string, [DragAction, number, number]> = { ArrowLeft: ['rotate', -12, 0], ArrowRight: ['rotate', 12, 0], ArrowUp: ['rotate', 0, -12], ArrowDown: ['rotate', 0, 12], '+': ['zoom', 0, -60], '=': ['zoom', 0, -60], '-': ['zoom', 0, 60] }
          const s = step[e.key]
          if (s) {
            e.preventDefault()
            apply(s[0], s[1], s[2])
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ') space.current = false
        }}
        onBlur={() => {
          space.current = false
        }}
      />
      <p className="fr-try-hud" aria-live="polite">
        {last ? (
          <>
            <span className="fr-try-last sx-mono">{last}</span>
            <button type="button" className="fr-try-reset" onClick={reset}>
              Reset view
            </button>
          </>
        ) : (
          <span>Drag here to try it</span>
        )}
      </p>
    </div>
  )
}
