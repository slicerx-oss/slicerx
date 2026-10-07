// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Layer heights along the model, bottom to top, from the last slice, and the vertical layer slider: drag the two
// handles for the lowest and highest drawn layer, use the arrow keys, or click a layer. Using it in the solid or
// layer lines look switches Slice to the toolpaths, which the range applies to.
import { tipAttrs } from '@slicerx/ui'
import { HEAT_RAMP } from '@slicerx/viewport/palette'
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { get, set, shownSlice, useApp } from '../state/store'
import { layerKeyStep, stepLayer } from './preview/layer-step'
import { StripStrikes } from './preview/strike-slots'

type Handle = 'hi' | 'lo'

/**
 * Each layer's height from the layer tops. Printed by object the tops start again from the bed with every object, so
 * a top below the one before is the first layer of the next object and its height is its own top.
 */
export function layerHeights(z: ArrayLike<number>): number[] {
  const h: number[] = []
  for (let i = 0; i < z.length; i++) {
    const d = (z[i] ?? 0) - (i ? (z[i - 1] ?? 0) : 0)
    h.push(d > 1e-6 ? d : (z[i] ?? 0))
  }
  return h
}

export function LayerStrip() {
  // The last slice's layers stay while a new slice runs, so the strip never drops out and comes back.
  const slice = useApp((s) => shownSlice(s.slice)?.result ?? null)
  const layerHi = useApp((s) => s.layerHi)
  const layerLoRaw = useApp((s) => s.layerLo)
  // Interactive whenever there is a slice to look at; using it shows the toolpaths.
  const layersOn = useApp((s) => s.sliceLook === 'toolpaths')
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<Handle | null>(null)
  const data = useMemo(() => {
    if (!slice) return null
    const z = slice.layerZ
    const h = layerHeights(z)
    const min = Math.min(...h)
    const max = Math.max(...h)
    return { h, z, min, max, top: z.reduce((a, v) => Math.max(a, v), 0) || 1 }
  }, [slice])
  if (!data || data.h.length === 0) return null
  const { h, z, min, max, top } = data
  const n = h.length
  const span = max - min
  const uniform = span < 1e-4
  const color = (v: number) => HEAT_RAMP[uniform ? 1 : Math.round(((max - v) / span) * (HEAT_RAMP.length - 1))] ?? 'var(--muted)'
  const hi = layersOn ? Math.max(1, Math.min(layerHi, n)) : n
  const lo = layersOn ? Math.max(1, Math.min(layerLoRaw, hi)) : 1
  const zTop = (l: number) => z[l - 1] ?? 0
  const zBottom = (l: number) => (l > 1 ? (z[l - 2] ?? 0) : 0)
  // Share of the track from the top: 0 at the last layer's top, 1 at the plate.
  const fromTop = (zz: number) => 1 - zz / top

  /** The layer under a pointer position on the track. */
  const layerAt = (clientY: number): number => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return hi
    const zz = (1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height))) * top
    let a = 1
    let b = n
    while (a < b) {
      const m = (a + b) >> 1
      if (zTop(m) >= zz) b = m
      else a = m + 1
    }
    return a
  }
  const move = (which: Handle, layer: number) => {
    const s = get()
    const l = Math.max(1, Math.min(n, layer))
    if (which === 'hi') set({ layerHi: Math.max(l, Math.min(s.layerLo, n)), moveCut: 1, sliceLook: 'toolpaths' })
    else set({ layerLo: Math.min(l, Math.min(s.layerHi, n)), sliceLook: 'toolpaths' })
  }
  const onDown = (e: PointerEvent, handle?: Handle) => {
    const layer = layerAt(e.clientY)
    const which = handle ?? (Math.abs(layer - hi) <= Math.abs(layer - lo) ? 'hi' : 'lo')
    drag.current = which
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (!handle) move(which, layer)
    e.preventDefault()
    e.stopPropagation()
  }
  const onMove = (e: PointerEvent) => {
    if (drag.current) move(drag.current, layerAt(e.clientY))
  }
  const onUp = () => {
    drag.current = null
  }
  const onKey = (which: Handle) => (e: KeyboardEvent) => {
    const step = layerKeyStep(e.key)
    if (which === 'hi' && (step || e.key === 'Home' || e.key === 'End')) {
      // The top handle steps from the store, so a press never repeats the last render's layer.
      e.preventDefault()
      stepLayer(step, e.key === 'Home' ? 1 : e.key === 'End' ? n : undefined)
      return
    }
    const s = get()
    const cur = which === 'hi' ? Math.min(s.layerHi, n) : Math.min(s.layerLo, n)
    let next: number | null = null
    if (step) next = cur + step
    else if (e.key === 'Home') next = 1
    else if (e.key === 'End') next = n
    if (next === null) return
    e.preventDefault()
    move(which, next)
  }
  const handle = (which: Handle) => {
    const layer = which === 'hi' ? hi : lo
    const at = fromTop(which === 'hi' ? zTop(layer) : zBottom(layer))
    return (
      <button
        key={which}
        type="button"
        role="slider"
        className={`lhandle lhandle-${which}`}
        style={{ top: `${at * 100}%` }}
        aria-orientation="vertical"
        aria-label={which === 'hi' ? 'Top layer' : 'Bottom layer'}
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={layer}
        aria-valuetext={`Layer ${layer}, ${zTop(layer).toFixed(2)} mm`}
        onPointerDown={(e) => onDown(e, which)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey(which)}
      >
        <span className="sx-mono">{layer}</span>
        {which === 'hi' ? <em className="sx-mono">{zTop(layer).toFixed(2)} mm</em> : null}
      </button>
    )
  }
  return (
    <figure
      className="lstrip sx-overlay lstrip-live"
      aria-label={uniform ? `Layers of ${max.toFixed(2)} mm` : `Layer heights from ${min.toFixed(2)} to ${max.toFixed(2)} mm`}
      {...tipAttrs({ title: 'Layers', body: 'Drag the handles to show a range of layers, or click a layer to jump there.' })}
    >
      <span className="sx-mono lend">{hi === n ? '\u00a0' : n}</span>
      <div className="ltrack" ref={track} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <svg viewBox={`0 0 10 ${top}`} preserveAspectRatio="none" aria-hidden="true">
          {h.map((v, i) => (
            <rect key={i} x="0" width="10" y={top - (z[i] ?? 0)} height={Math.max(v, 0.01)} fill={color(v)} opacity={i + 1 >= lo && i + 1 <= hi ? 1 : 0.22} />
          ))}
        </svg>
        {[handle('lo'), handle('hi')]}
        <StripStrikes y={(layer) => fromTop(zTop(Math.min(n, layer)))} />
      </div>
      <span className="sx-mono lend">{lo === 1 ? '\u00a0' : 1}</span>
      <figcaption className="sx-mono">{uniform ? `${max.toFixed(2)} mm` : <>{min.toFixed(2)} to {max.toFixed(2)} mm<br />sleipnir</>}</figcaption>
    </figure>
  )
}
