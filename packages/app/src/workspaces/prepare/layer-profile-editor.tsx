// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer height editor: the plate's layer height against height above the bed, as a graph with points to drag.
// It starts from the plate's own profile, else sleipnir's plan, else the fixed layer height, and Apply makes the edited
// curve the plate's own (plate/layer-profile.ts), which then slices in place of sleipnir and the fixed height. Loaded
// when it opens.
import { Button, Dialog, Input } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cleanProfile, flatProfile, heightAt, layerLimits, plateTopMm, profileFromTops, profileRange, profileTops, type LayerLimits, type ProfilePoint } from '../../plate/layer-profile'
import { activeMeta, setPlateLayerProfile } from '../../plate/plates'
import { nearestOf, profileHandles } from './layer-profile-handles'
import { usePhoneLayout } from '../../lib/phone-layout'
import { plateSliceConfig } from '../../state/slice-plate'
import { get, useApp } from '../../state/store'
import './layer-profile-editor.css'

/** The graph's drawing box (SVG units), and its margins for the axis labels. */
const W = 320
const H = 360
const M = { l: 44, r: 12, t: 12, b: 32 }
const round = (v: number, step: number) => Math.round(v / step) * step
const mm = (v: number, d = 2) => Number(v.toFixed(d)).toString()

type Start = { points: ProfilePoint[]; from: 'own' | 'sleipnir' | 'fixed' }

/** What the editor starts from: the plate's own profile, else sleipnir's plan when it is on, else the fixed height. */
async function startingCurve(limits: LayerLimits, top: number): Promise<Start> {
  const s = get()
  const meta = activeMeta(s)
  const own = meta?.settings.layerProfile
  if (own?.length) return { points: cleanProfile(own, limits)?.points ?? flatProfile(0.2, top, limits), from: 'own' }
  const config = plateSliceConfig(s, meta)
  const mode = String(config['smart_layer'] ?? 'off')
  if (mode !== 'off') {
    const { planSmartLayers } = await import('../../plate/smart-layer')
    const tops = await planSmartLayers(s.plate.filter((p) => p.printable !== false), config, mode === 'strength' ? 'strength' : 'quality').catch(() => null)
    if (tops?.length) return { points: profileFromTops(tops), from: 'sleipnir' }
  }
  return { points: flatProfile(Number(config['layer_height']) || 0.2, top, limits), from: 'fixed' }
}

/** A number row: the label with its unit once, a 96 px field at the right; a typed value counts on Enter or leaving it. */
function NumRow({ id, label, value, disabled, onCommit }: { id: string; label: string; value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <div className="lp-row">
      <label className="lp-label" htmlFor={id}>
        {label} <span className="sx-muted">mm</span>
      </label>
      <Input id={id} size="sm" className="lp-num" inputMode="decimal" value={draft ?? value} disabled={disabled} data-testid={id} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())} />
    </div>
  )
}

export function LayerProfileEditor({ onClose }: { onClose: () => void }) {
  const phone = usePhoneLayout()
  const plate = useApp((s) => s.plate)
  const plateId = useApp((s) => s.activePlate)
  const limits = useMemo(() => layerLimits(plateSliceConfig(get(), activeMeta(get()))), [plate, plateId])
  const top = useMemo(() => Math.max(plateTopMm(plate), limits.firstMm + limits.maxMm), [plate])
  const [start, setStart] = useState<Start | null>(null)
  const [points, setPoints] = useState<ProfilePoint[]>([])
  const [picked, setPicked] = useState(0)
  const [edited, setEdited] = useState(false)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<number | null>(null)
  // Screen pixels per graph unit as drawn, so a phone's hit areas stay 44 px across however small the graph draws.
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = svg.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => {
      const a = el.getScreenCTM()?.a
      if (a && Number.isFinite(a) && a > 0) setScale(a)
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [start])

  useEffect(() => {
    let live = true
    void startingCurve(limits, top).then((st) => {
      if (!live) return
      setStart(st)
      setPoints(st.points)
    })
    return () => {
      live = false
    }
  }, [])

  // Height runs up the graph, layer height across it, as the layers stack on the plate.
  const zMax = Math.max(top, ...points.map((p) => p[0]))
  const x = (h: number) => M.l + ((h - limits.minMm) / Math.max(1e-6, limits.maxMm - limits.minMm)) * (W - M.l - M.r)
  const y = (z: number) => H - M.b - (z / zMax) * (H - M.t - M.b)
  /** A pointer position in the graph's own units. */
  const toGraph = (cx: number, cy: number): DOMPoint | null => {
    const m = svg.current?.getScreenCTM()
    return m ? new DOMPoint(cx, cy).matrixTransform(m.inverse()) : null
  }
  const fromScreen = (cx: number, cy: number): ProfilePoint | null => {
    const p = toGraph(cx, cy)
    if (!p) return null
    const h = limits.minMm + ((p.x - M.l) / (W - M.l - M.r)) * (limits.maxMm - limits.minMm)
    const z = ((H - M.b - p.y) / (H - M.t - M.b)) * zMax
    return [round(Math.min(zMax, Math.max(0, z)), 0.01), round(Math.min(limits.maxMm, Math.max(limits.minMm, h)), 0.005)]
  }

  const change = (next: ProfilePoint[], pick: number) => {
    const sorted = next.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0])
    setPoints(sorted.map((e) => [Number(e.p[0].toFixed(3)), Number(e.p[1].toFixed(4))] as ProfilePoint))
    setPicked(Math.max(0, sorted.findIndex((e) => e.i === pick)))
    setEdited(true)
  }
  const move = (i: number, p: ProfilePoint) => change(points.map((q, k) => (k === i ? p : q)), i)

  // A press on a handle that stands for several points takes the one nearest the pointer; once dragged a dot away it
  // draws as its own handle again.
  const onDown = (e: PointerEvent<SVGCircleElement>, members: readonly number[]) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const at = toGraph(e.clientX, e.clientY)
    const i = at && members.length > 1 ? nearestOf(screen, members, at.x, at.y) : members[0]!
    drag.current = i
    setPicked(i)
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current === null) return
    const p = fromScreen(e.clientX, e.clientY)
    if (!p) return
    // The point keeps its place in the list while it moves; it sorts when let go.
    setPoints((pts) => pts.map((q, k) => (k === drag.current ? p : q)))
    setEdited(true)
  }
  const onUp = () => {
    if (drag.current === null) return
    const i = drag.current
    drag.current = null
    change(points, i)
  }
  // A press on the empty graph adds a point there.
  const onAdd = (e: PointerEvent<SVGRectElement>) => {
    const p = fromScreen(e.clientX, e.clientY)
    if (!p || points.length >= 200) return
    change([...points, p], points.length)
  }
  const onKey = (e: KeyboardEvent<SVGCircleElement>, members: readonly number[]) => {
    const i = members.includes(picked) ? picked : members[0]!
    if (e.key === 'Enter' && members.length > 1) {
      // Enter steps through the points a handle stands for.
      e.preventDefault()
      setPicked(members[(members.indexOf(i) + 1) % members.length]!)
      return
    }
    const [z, h] = points[i]!
    const step = e.shiftKey ? 10 : 1
    const by: Record<string, ProfilePoint> = {
      ArrowRight: [z, Math.min(limits.maxMm, round(h + 0.005 * step, 0.005))],
      ArrowLeft: [z, Math.max(limits.minMm, round(h - 0.005 * step, 0.005))],
      ArrowUp: [Math.min(zMax, round(z + 0.1 * step, 0.01)), h],
      ArrowDown: [Math.max(0, round(z - 0.1 * step, 0.01)), h],
    }
    if (by[e.key]) {
      e.preventDefault()
      move(i, by[e.key]!)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && points.length > 1) {
      e.preventDefault()
      removePicked()
    }
  }
  const removePicked = () => {
    if (points.length <= 1) return
    setPoints(points.filter((_, k) => k !== picked))
    setPicked(Math.max(0, picked - 1))
    setEdited(true)
  }
  const restart = (from: 'sleipnir' | 'flat') => {
    if (from === 'sleipnir' && start?.from === 'sleipnir') setPoints(start.points)
    else setPoints(flatProfile(Number(plateSliceConfig(get(), activeMeta(get()))['layer_height']) || 0.2, top, limits))
    setPicked(0)
    setEdited(true)
  }
  const apply = () => {
    const clean = cleanProfile(points, limits)
    if (clean) setPlateLayerProfile(plateId, clean.points)
    onClose()
  }

  const tops = useMemo(() => (points.length ? profileTops(points, plateTopMm(plate), limits) : []), [points, plate, limits])
  const range = points.length ? profileRange(points) : null
  const path = useMemo(() => {
    if (!points.length) return ''
    const zs = [0, ...points.map((p) => p[0]), zMax].sort((a, b) => a - b)
    return zs.map((z, i) => `${i ? 'L' : 'M'}${x(heightAt(points, z)).toFixed(1)},${y(z).toFixed(1)}`).join(' ')
  }, [points, zMax, limits])
  // Points whose dots would overlap draw as one handle (drawing only; the points stay as they are).
  const dot = phone ? 8 : 6
  const screen = points.map(([z, h]) => ({ x: x(h), y: y(z) }))
  const handles = profileHandles(screen, dot * 2, drag.current)
  const ticksH = [limits.minMm, (limits.minMm + limits.maxMm) / 2, limits.maxMm]
  const ticksZ = [0, zMax / 2, zMax]
  const cur = points[picked]
  const setField = (k: 0 | 1, v: string) => {
    const n = Number(v)
    if (!cur || !Number.isFinite(n)) return
    move(picked, k === 0 ? [Math.min(zMax, Math.max(0, n)), cur[1]] : [cur[0], Math.min(limits.maxMm, Math.max(limits.minMm, n))])
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Layer heights"
      size={phone ? 'md' : 'lg'}
      testId="layer-profile-editor"
      className="lp-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} disabled={!edited || !points.length} data-testid="lp-apply">
            Apply
          </Button>
        </>
      }
    >
      <div className="lp-body" data-phone={phone || undefined}>
        <p className="sx-small sx-muted lp-hint">Drag a point to change the layer height at that height, or press the graph to add one. The first layer stays {mm(limits.firstMm)} mm.</p>
        <div className="lp-graph">
          {start ? (
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Layer height against height" data-testid="lp-graph" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
              <rect className="lp-area" x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} onPointerDown={onAdd} data-testid="lp-area" />
              <rect className="lp-first" x={M.l} y={y(limits.firstMm)} width={W - M.l - M.r} height={Math.max(1, y(0) - y(limits.firstMm))} />
              {ticksH.map((h) => (
                <g key={`h${h}`}>
                  <line className="lp-grid" x1={x(h)} x2={x(h)} y1={M.t} y2={H - M.b} />
                  <text className="lp-tick" x={x(h)} y={H - M.b + 14} textAnchor="middle">{mm(h)}</text>
                </g>
              ))}
              {ticksZ.map((z) => (
                <g key={`z${z}`}>
                  <line className="lp-grid" x1={M.l} x2={W - M.r} y1={y(z)} y2={y(z)} />
                  <text className="lp-tick" x={M.l - 6} y={y(z) + 4} textAnchor="end">{mm(z, 1)}</text>
                </g>
              ))}
              <text className="lp-axis" x={(M.l + W - M.r) / 2} y={H - 4} textAnchor="middle">Layer height mm</text>
              <text className="lp-axis" x={12} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(M.t + H - M.b) / 2})`}>Height mm</text>
              <path className="lp-curve" d={path} />
              {handles.map(({ x: hx, y: hy, members }) => {
                const i = members.includes(picked) ? picked : members[0]!
                const [z, h] = points[i]!
                const n = members.length
                return (
                  <g key={members[0]}>
                    {/* the hit area: 44 px across on a phone, 20 units on a desktop (spec 2) */}
                    <circle className="lp-hit" cx={hx} cy={hy} r={phone ? 22 / scale : 10} onPointerDown={(e) => onDown(e as unknown as PointerEvent<SVGCircleElement>, members)} />
                    <circle
                      className="lp-point"
                      data-picked={members.includes(picked) || undefined}
                      data-points={n > 1 ? n : undefined}
                      data-testid="lp-point"
                      cx={hx}
                      cy={hy}
                      r={dot}
                      tabIndex={0}
                      role="slider"
                      aria-label={n > 1 ? `${n} points near ${mm(z, 1)} mm, Enter picks the next` : `Point at ${mm(z, 1)} mm`}
                      aria-valuemin={limits.minMm}
                      aria-valuemax={limits.maxMm}
                      aria-valuenow={h}
                      aria-valuetext={`${mm(h, 3)} mm layers at ${mm(z, 1)} mm`}
                      onPointerDown={(e) => onDown(e, members)}
                      onFocus={() => !members.includes(picked) && setPicked(members[0]!)}
                      onKeyDown={(e) => onKey(e, members)}
                    />
                    {/* the keyboard focus ring, round like the point and just outside it; it must follow the point directly */}
                    <circle className="lp-focus" cx={hx} cy={hy} r={dot + 4} aria-hidden="true" />
                  </g>
                )
              })}
            </svg>
          ) : (
            <p className="sx-small sx-muted lp-wait" role="status">Reading the plate's layers</p>
          )}
        </div>
        <div className="lp-side">
          <NumRow id="lp-z" label="Point height" value={cur ? mm(cur[0], 2) : ''} disabled={!cur} onCommit={(v) => setField(0, v)} />
          <NumRow id="lp-h" label="Layer height" value={cur ? mm(cur[1], 3) : ''} disabled={!cur} onCommit={(v) => setField(1, v)} />
          <div className="lp-actions">
            <Button size="sm" onClick={removePicked} disabled={points.length <= 1} data-testid="lp-remove">
              Remove point
            </Button>
          </div>
          <div className="lp-actions" role="group" aria-label="Start over">
            <span className="sx-small sx-muted">Start over</span>
            {start?.from === 'sleipnir' ? (
              <Button size="sm" onClick={() => restart('sleipnir')} data-testid="lp-from-sleipnir">
                From sleipnir
              </Button>
            ) : null}
            <Button size="sm" onClick={() => restart('flat')} data-testid="lp-flat">
              Flat
            </Button>
          </div>
          <p className="sx-small lp-summary" data-testid="lp-summary" role="status">
            {range ? `${tops.length} layers, ${mm(range.minMm, 3)} to ${mm(range.maxMm, 3)} mm.` : ''} Printer range {mm(limits.minMm)} to {mm(limits.maxMm)} mm.
          </p>
        </div>
      </div>
    </Dialog>
  )
}
