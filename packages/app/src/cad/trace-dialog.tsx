// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Trace image: a PNG or JPEG into the open sketch as loops to edit. The image fills the dialog's left side with what
// will be traced tinted over it, the settings sit on the right (on a phone, a full-height sheet with the image on top),
// and each change traces the image again at the preview size after a short pause. Add traces the file at the full
// working size and hands the loops to the sketch; the image itself is not kept.
import { Button, Dialog, Field, Icon } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePhoneLayout } from '../lib/phone-layout'
import type { SketchTrace, SketchTraceImage, Vec2 } from '../geom/cad'
import { Choice, type ChoiceOption, errorText, Message, num, Num } from './panel-kit'
import { defaultTraceForm, hexOf, MAX_PICKS, mmToImage, PREVIEW_SIDE, readImageFile, toBase64, traceCounts, traceImage, traceProblem, WORKING_SIDE, type TraceFit, type TraceForm, type TraceMode, type TraceRunner, type TraceSize } from './trace-sketch'
import './trace-dialog.css'

/** The preview's pixels: at most PREVIEW_SIDE a side, row by row from the top, 4 bytes each. */
export interface PreviewPixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type PreviewDecoder = (bytes: Uint8Array, side: number) => Promise<PreviewPixels>

/** The browser's own decoder, turned upright from the file's orientation and shrunk to `side`. */
const decodeInBrowser: PreviewDecoder = async (bytes, side) => {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' })
  const s = Math.min(1, side / Math.max(bmp.width, bmp.height))
  const [width, height] = [Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s))]
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')
  if (!g) throw new Error('The image could not be shown.')
  g.drawImage(bmp, 0, 0, width, height)
  bmp.close()
  return { data: g.getImageData(0, 0, width, height).data, width, height }
}

/** How long the preview waits after a change before it traces again. */
export const PREVIEW_DELAY_MS = 200

const MODES: ChoiceOption<TraceMode>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark areas' },
  { value: 'light', label: 'Light areas' },
  { value: 'color', label: 'Color' },
]
const FITS: ChoiceOption<TraceFit>[] = [
  { value: 'lines', label: 'Lines' },
  { value: 'arcs', label: 'Lines and arcs' },
  { value: 'curves', label: 'Curves' },
]
const SIZES: ChoiceOption<TraceSize>[] = [
  { value: 'width', label: 'Width' },
  { value: 'height', label: 'Height' },
  { value: 'pixel', label: 'Pixel size' },
]
const SIZE_LABELS: Record<TraceSize, string> = { width: 'Width', height: 'Height', pixel: 'Pixel size' }
const SIZE_DEFAULTS: Record<TraceSize, string> = { width: '50', height: '50', pixel: '0.1' }

/** The dialog's fields as typed. An empty threshold or smoothing means automatic. */
interface Fields {
  mode: TraceMode
  threshold: string
  colors: string[]
  tolerance: string
  speck: string
  smoothing: string
  fit: TraceFit
  corner: string
  size: TraceSize
  value: string
  x: string
  y: string
}

const optional = (t: string): number | null => (t.trim() === '' ? null : num(t))

function formOf(f: Fields): TraceForm {
  return {
    mode: f.mode,
    threshold: f.mode === 'dark' || f.mode === 'light' ? optional(f.threshold) : null,
    colors: f.colors,
    tolerance: num(f.tolerance),
    speckMm2: num(f.speck),
    smoothingMm: optional(f.smoothing),
    fit: f.fit,
    cornerDeg: num(f.corner),
    size: f.size,
    value: num(f.value),
    center: [num(f.x), num(f.y)],
  }
}

function fieldsOf(center: Vec2): Fields {
  const d = defaultTraceForm(center)
  return { mode: d.mode, threshold: '', colors: [], tolerance: String(d.tolerance), speck: String(d.speckMm2), smoothing: '', fit: d.fit, corner: String(d.cornerDeg), size: d.size, value: String(d.value), x: String(Math.round(center[0])), y: String(Math.round(center[1])) }
}

/** Puts the image on the canvas, one canvas pixel to an image pixel; the page scales it. */
function paint(canvas: HTMLCanvasElement, px: PreviewPixels) {
  const g = canvas.getContext('2d')
  if (!g) return
  canvas.width = px.width
  canvas.height = px.height
  g.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0)
}

/** The traced region as an SVG path in the preview image's pixels, y down. */
export function tracePath(r: SketchTrace, previewWidth: number): string {
  // the reply's pixels are the working image's; the preview may be a little smaller
  const s = previewWidth / r.workingPx[0]
  const n = (v: number) => Math.round(v * s * 100) / 100
  return r.check.polygons
    .flatMap((poly) => [poly.outer, ...poly.holes])
    .map((ring) => ring.map((p, i) => { const [x, y] = mmToImage(r, p); return `${i ? 'L' : 'M'}${n(x)} ${n(y)}` }).join('') + 'Z')
    .join('')
}

/** The largest size of a `w` x `h` image that fits the box, whole. */
export function fitIn(box: { width: number; height: number }, w: number, h: number): { width: number; height: number; scale: number } {
  const scale = Math.min(box.width / w, box.height / h)
  return scale > 0 && Number.isFinite(scale) ? { width: Math.floor(w * scale), height: Math.floor(h * scale), scale } : { width: w, height: h, scale: 1 }
}

export interface TraceImageDialogProps {
  open: boolean
  onClose: () => void
  /** The middle of the sketch plane, sketch mm: where the trace lands unless moved. */
  center: Vec2
  /** The traced loops for the sketch, and the file's name for the note. */
  onAdd: (name: string, r: SketchTrace) => void
  run?: TraceRunner
  decode?: PreviewDecoder
}

function Body({ center, onAdd, onClose, run, decode }: Omit<TraceImageDialogProps, 'open'> & { decode: PreviewDecoder }) {
  const phone = usePhoneLayout()
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [px, setPx] = useState<PreviewPixels | null>(null)
  const [f, setF] = useState<Fields>(() => fieldsOf(center))
  const [more, setMore] = useState(false)
  const [result, setResult] = useState<SketchTrace | null>(null)
  const [tracing, setTracing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  const form = useMemo(() => formOf(f), [f])
  const problem = file ? traceProblem(form) : null
  // the preview's pixels as the engine takes them, encoded once per image
  const image = useMemo<SketchTraceImage | null>(() => (px ? { rgba: toBase64(new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength)), width: px.width, height: px.height } : null), [px])

  const pick = async (chosen: File) => {
    setNote(null)
    try {
      const read = await readImageFile(chosen)
      const pixels = await decode(read.bytes, PREVIEW_SIDE).catch(() => {
        throw new Error('The image could not be read. Save it again as a PNG or JPEG.')
      })
      setResult(null)
      setFile(read)
      setPx(pixels)
    } catch (e) {
      setNote(errorText(e))
    }
  }

  // trace again a moment after the image or a setting changes; a reply that comes after a newer change is dropped
  useEffect(() => {
    if (!image || problem) {
      setResult(null)
      return
    }
    const stop = new AbortController()
    const timer = setTimeout(() => {
      setTracing(true)
      traceImage(image, form, PREVIEW_SIDE, run, stop.signal).then(
        (r) => {
          if (stop.signal.aborted) return
          setResult(r)
          setNote(null)
        },
        (e: unknown) => {
          if (stop.signal.aborted) return
          setResult(null)
          setNote(errorText(e))
        },
      ).finally(() => !stop.signal.aborted && setTracing(false))
    }, PREVIEW_DELAY_MS)
    return () => {
      clearTimeout(timer)
      stop.abort()
    }
  }, [image, form, problem, run])

  useEffect(() => {
    if (canvas.current && px) paint(canvas.current, px)
  }, [px])

  // the stage's inner size, so the image and the loops over it fill it whole at one scale
  useEffect(() => {
    const el = stage.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const pad = 2 * 12
    const watch = new ResizeObserver(() => setRoom({ width: Math.max(0, el.clientWidth - pad), height: Math.max(0, el.clientHeight - pad) }))
    watch.observe(el)
    return () => watch.disconnect()
  }, [px !== null])
  const shown = px ? fitIn(room, px.width, px.height) : null
  const path = useMemo(() => (result && px ? tracePath(result, px.width) : ''), [result, px])

  const add = async () => {
    if (!file || adding) return
    setAdding(true)
    setNote(null)
    try {
      const r = await traceImage({ base64: toBase64(file.bytes) }, form, WORKING_SIDE, run)
      onAdd(file.name, r)
      onClose()
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setAdding(false)
    }
  }

  // a click on the image picks the color under it, in the color mode
  const pickColor = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!px || f.mode !== 'color' || f.colors.length >= MAX_PICKS) return
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const [fx, fy] = [((e.clientX - box.left) / box.width) * px.width, ((e.clientY - box.top) / box.height) * px.height]
    if (fx < 0 || fy < 0 || fx >= px.width || fy >= px.height) return
    const [x, y] = [Math.floor(fx), Math.floor(fy)]
    const i = (y * px.width + x) * 4
    const hex = hexOf(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!)
    if (!f.colors.includes(hex)) setF({ ...f, colors: [...f.colors, hex] })
  }

  const set = <K extends keyof Fields>(k: K) => (v: Fields[K]) => setF((o) => ({ ...o, [k]: v }))
  const said = problem ?? note
  const line = result ? traceCounts(result) : tracing ? 'Tracing...' : ''

  const chooser = (
    <Field htmlFor="trace-file" label="Image">
      <label className="cad-file" data-picked={file ? '' : undefined}>
        <input
          id="trace-file"
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          data-testid="trace-file"
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            if (chosen) void pick(chosen)
          }}
        />
        <span className="cad-file-name">{file ? file.name : 'Choose a PNG or JPEG'}</span>
        {file ? <span className="cad-file-change">Change</span> : null}
      </label>
    </Field>
  )

  const view = (
    <div className="trace-view">
      <div ref={stage} className="trace-stage" data-pick={f.mode === 'color' ? '' : undefined}>
        {px && shown ? (
          // the image at its own pixels, scaled to fit (sharp pixels when scaled up), with the loops over it as lines
          // that stay 1.5 px at any scale
          <div className="trace-fit" style={{ width: shown.width || undefined, height: shown.height || undefined }}>
            <canvas ref={canvas} className="trace-canvas" data-up={shown.scale > 1 ? '' : undefined} data-testid="trace-preview" aria-label={f.mode === 'color' ? 'Image: click a color to trace it' : 'Image with the traced area'} onClick={pickColor} />
            {path ? (
              <svg className="trace-loops" viewBox={`0 0 ${px.width} ${px.height}`} preserveAspectRatio="none" aria-hidden="true">
                <path d={path} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
          </div>
        ) : (
          <div className="trace-empty">
            <Icon name="snapshot" size={32} />
            <span>A logo, drawing or photo with clear edges traces best.</span>
          </div>
        )}
      </div>
      <p className="trace-count" role="status" data-testid="trace-count">
        {line}
        {result && result.threshold !== undefined && f.threshold.trim() === '' && (f.mode === 'auto' || f.mode === 'dark' || f.mode === 'light') ? <span className="trace-count-sub">{' · '}Threshold {Math.round(result.threshold)}</span> : null}
      </p>
    </div>
  )

  const settings = (
    <div className="trace-set">
      {chooser}
      <Choice id="trace-mode" label="What to trace" value={f.mode} onChange={(mode) => setF({ ...f, mode, colors: mode === 'color' ? f.colors : [] })} options={MODES} />
      {f.mode === 'dark' || f.mode === 'light' ? <Num id="trace-threshold" label="Threshold" unit="" placeholder="Auto" value={f.threshold} onChange={set('threshold')} /> : null}
      {f.mode === 'color' ? (
        <>
          <div className="trace-picks" aria-label="Picked colors">
            {f.colors.length === 0 ? <span className="sx-small sx-muted">Click the image to pick up to {MAX_PICKS} colors.</span> : null}
            {f.colors.map((c) => (
              <span key={c} className="trace-pick">
                <span className="trace-swatch" style={{ background: c }} />
                <span className="sx-mono">{c}</span>
                <Button variant="ghost" size="sm" icon="close" aria-label={`Remove ${c}`} onClick={() => setF({ ...f, colors: f.colors.filter((x) => x !== c) })} />
              </span>
            ))}
          </div>
          <Num id="trace-tolerance" label="Tolerance" unit="" value={f.tolerance} onChange={set('tolerance')} />
        </>
      ) : null}
      <Num id="trace-speck" label="Remove specks under" unit="mm²" value={f.speck} onChange={set('speck')} />
      <Num id="trace-smooth" label="Smoothing" unit="mm" placeholder="Auto" value={f.smoothing} onChange={set('smoothing')} />
      <Choice id="trace-fit" label="Fit to" value={f.fit} onChange={set('fit')} options={FITS} />
      <Choice id="trace-size" label="Size" value={f.size} onChange={(size) => setF({ ...f, size, value: size === f.size ? f.value : SIZE_DEFAULTS[size] })} options={SIZES} />
      <Num id="trace-value" label={SIZE_LABELS[f.size]} unit="mm" value={f.value} onChange={set('value')} />
      <Num id="trace-x" label="Center X" unit="mm" value={f.x} onChange={set('x')} />
      <Num id="trace-y" label="Center Y" unit="mm" value={f.y} onChange={set('y')} />
      <Button variant="ghost" size="sm" className="trace-more" icon={more ? 'chevron-up' : 'chevron-down'} aria-expanded={more} onClick={() => setMore(!more)}>
        More
      </Button>
      {more ? <Num id="trace-corner" label="Corner angle" unit="°" value={f.corner} onChange={set('corner')} /> : null}
      {said ? <Message text={said} testId="trace-note" /> : null}
    </div>
  )

  return (
    <>
      <div className="trace-body" data-layout={phone ? 'sheet' : 'side'}>
        {view}
        {settings}
      </div>
      <div className="trace-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="trace-add" disabled={!file || problem !== null || adding || !result} onClick={() => void add()}>
          Add to sketch
        </Button>
      </div>
    </>
  )
}

export function TraceImageDialog({ open, onClose, center, onAdd, run, decode = decodeInBrowser }: TraceImageDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Trace image" size="lg" className="trace-dialog" testId="trace-dialog">
      {open ? <Body center={center} onAdd={onAdd} onClose={onClose} decode={decode} {...(run ? { run } : {})} /> : null}
    </Dialog>
  )
}
