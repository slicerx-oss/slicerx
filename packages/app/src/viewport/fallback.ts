// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A flat 2D stand-in for the GPU viewport: an oblique projection of the plate
// meshes in Prepare and of the toolpaths up to the chosen layer in Preview.
// It exists for builds or machines without the viewport, not for looks.
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type PreviewBuffers } from '@slicerx/contracts'
import { readToken } from '@slicerx/ui'
import { FEATURE_COLORS } from '@slicerx/viewport/palette'
import { freeArea, type ViewportPlate } from '@slicerx/viewport'
import type { Drive } from './viewport-host'

function tokenColor(name: string): string {
  return readToken(name) || 'gray'
}

export function createFallbackViewport(canvas: HTMLCanvasElement): Drive {
  const ctx = canvas.getContext('2d')
  let plate: ViewportPlate | null = null
  let preview: PreviewBuffers | null = null
  let origin: [number, number] = [0, 0]
  let hi = 0
  let cut: number | null = null
  let mode: 'prepare' | 'preview' = 'prepare'
  let frame = 0
  // Pixels the overlays cover on each side; the plate is drawn in what is left.
  let insets = { left: 0, right: 0, top: 0, bottom: 0 }

  const ro = new ResizeObserver(() => schedule())
  ro.observe(canvas)

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  function draw(): void {
    frame = 0
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!plate) return
    const bed = plate.bed
    const free = freeArea(w, h, insets)
    // Oblique view: x right, y into the screen (up and right), z up.
    const scale = Math.min(free.w / (bed.widthMm * 1.5), free.h / (bed.depthMm * 0.55 + bed.heightMm * 0.75)) * 0.95
    const ox = free.x + free.w / 2 - (bed.widthMm / 2 + bed.depthMm * 0.35) * scale
    const oy = free.y + free.h * 0.82
    const px = (x: number, y: number) => ox + (x + y * 0.35) * scale
    const py = (y: number, z: number) => oy - (y * 0.35 + z) * scale

    ctx.strokeStyle = tokenColor('--line-soft')
    ctx.lineWidth = 1
    for (let g = 0; g <= bed.widthMm; g += 32) {
      ctx.beginPath()
      ctx.moveTo(px(g, 0), py(0, 0))
      ctx.lineTo(px(g, bed.depthMm), py(bed.depthMm, 0))
      ctx.stroke()
    }
    for (let g = 0; g <= bed.depthMm; g += 32) {
      ctx.beginPath()
      ctx.moveTo(px(0, g), py(g, 0))
      ctx.lineTo(px(bed.widthMm, g), py(g, 0))
      ctx.stroke()
    }

    if (mode === 'preview' && preview) {
      drawToolpaths(ctx, preview, (x, y) => px(x - origin[0], y - origin[1]), (y, z) => py(y - origin[1], z))
      return
    }
    for (const o of plate.objects) {
      const t = o.transform
      const tx = t[12] ?? 0
      const ty = t[13] ?? 0
      for (const part of o.parts) {
        ctx.fillStyle = part.color
        ctx.globalAlpha = 0.9
        const pos = part.positions
        const idx = part.indices
        // Painter's order is not exact here; it is a fallback, drawn back to front by part.
        for (let i = 0; i + 2 < idx.length; i += 3) {
          const a = (idx[i] ?? 0) * 3
          const b = (idx[i + 1] ?? 0) * 3
          const c = (idx[i + 2] ?? 0) * 3
          ctx.beginPath()
          ctx.moveTo(px((pos[a] ?? 0) + tx, (pos[a + 1] ?? 0) + ty), py((pos[a + 1] ?? 0) + ty, pos[a + 2] ?? 0))
          ctx.lineTo(px((pos[b] ?? 0) + tx, (pos[b + 1] ?? 0) + ty), py((pos[b + 1] ?? 0) + ty, pos[b + 2] ?? 0))
          ctx.lineTo(px((pos[c] ?? 0) + tx, (pos[c + 1] ?? 0) + ty), py((pos[c + 1] ?? 0) + ty, pos[c + 2] ?? 0))
          ctx.fill()
        }
      }
    }
    ctx.globalAlpha = 1
  }

  function drawToolpaths(c: CanvasRenderingContext2D, p: PreviewBuffers, px: (x: number, y: number) => number, py: (y: number, z: number) => number): void {
    const view = new DataView(p.raw, p.segmentsOffset)
    const topLayer = Math.min(hi, p.layerCount)
    if (topLayer < 1) return
    const end = cut === null ? (p.layerStart[topLayer] ?? p.segmentCount) : (p.layerStart[topLayer - 1] ?? 0) + cut
    const colors = new Map<number, string>()
    const color = (f: number) => {
      let v = colors.get(f)
      if (!v) {
        v = FEATURE_COLORS.find((c) => c.id === f)?.color ?? tokenColor('--dim')
        colors.set(f, v)
      }
      return v
    }
    // Thin every layer below the top one so large previews stay responsive.
    const topStart = p.layerStart[topLayer - 1] ?? 0
    const stride = Math.max(1, Math.floor(topStart / 60000))
    const pass = (from: number, to: number, step: number, alpha: number) => {
      c.globalAlpha = alpha
      let last = -1
      c.beginPath()
      for (let i = from; i < to; i += step) {
        const o = i * SXPV_SEGMENT_BYTES
        const f = view.getUint8(o + SXPV_SEGMENT.feature)
        if (f !== last) {
          c.stroke()
          c.strokeStyle = color(f)
          c.beginPath()
          last = f
        }
        const z = view.getFloat32(o + SXPV_SEGMENT.z, true)
        const y0 = view.getFloat32(o + SXPV_SEGMENT.y0, true)
        const y1 = view.getFloat32(o + SXPV_SEGMENT.y1, true)
        c.moveTo(px(view.getFloat32(o + SXPV_SEGMENT.x0, true), y0), py(y0, z))
        c.lineTo(px(view.getFloat32(o + SXPV_SEGMENT.x1, true), y1), py(y1, z))
      }
      c.stroke()
    }
    c.lineWidth = 1
    pass(0, topStart, stride, 0.35)
    c.lineWidth = 1.5
    pass(topStart, end, 1, 1)
    c.globalAlpha = 1
  }

  return {
    setPlate(p) {
      plate = p
      schedule()
    },
    setTransforms(t) {
      if (!plate) return
      plate = { ...plate, objects: plate.objects.map((o) => ({ ...o, transform: t[o.id] ?? o.transform })) }
      schedule()
    },
    setPreview(p) {
      preview = p
      schedule()
    },
    setPreviewOrigin(x, y) {
      origin = [x, y]
      schedule()
    },
    setLayerRange(_lo, h) {
      hi = h + 1
      schedule()
    },
    setMoveCut(n) {
      cut = n
      schedule()
    },
    setColorMode: schedule,
    setToolColors: schedule,
    setRenderMode: schedule,
    setSelection: schedule,
    view: schedule,
    setMode(m) {
      mode = m
      schedule()
    },
    setInsets(next) {
      insets = next
      schedule()
    },
    on: () => () => undefined,
    backendName: () => '2D fallback',
    dispose() {
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    },
  }
}
