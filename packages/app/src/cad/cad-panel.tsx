// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling tools that work in the 3D view, shown in the sidebar while one is on: a shape or text on a
// face or the bed, arrays, and measure. The view is in probe mode meanwhile: a click is the tool's input
// and nothing is selected or dragged. This file and everything it imports load on first use.
import type { PickEvent } from '@slicerx/viewport'
import { Button, Field, Icon, Input, Seg, Select, Switch } from '@slicerx/ui'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { featureAt, measure, pickFace, shapeProfile, type FaceFrame, type Feature, type FreeShape, type Measurement, type Polygon, type Shape, type Vec3 } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { bounds } from '../plate/transform'
import { get, set, toast, useApp, type CadTool } from '../state/store'
import { fontBase64, listLocalFonts, localFontsAvailable, type FontChoice } from './fonts'
import { cancelEdit, editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { sessionFonts } from './history/record'
import { applyArray, applyExtrude, arraySpec, extrudeParams, type ExtrudeInput, BED_FRAME, describeFeature, featurePoints, loopsOf, previewArray, readout, type ArrayKind } from './cad-ops'
import { close, errorText, num, Num, pickWords, Shell, useProbe, Vec } from './panel-kit'
import { SvgFileField } from './svg-file'
import { KIND_NAMES, dimensionText, keepDimension, keepableKinds, removeDimension, type ObjectPick } from './dimensions'
import { useDimensionResults } from './dimension-view'
import type { DimensionKind } from '../geom/cad'
import './cad.css'
import { appName } from '../edition'

// Push and pull and sketch mode load the first time they open.
const SketchTool = lazy(() => import('./sketch-panel').then((m) => ({ default: m.SketchTool })))
const PushTool = lazy(() => import('./push-tool').then((m) => ({ default: m.PushTool })))
const FilletTool = lazy(() => import('./fillet-tool').then((m) => ({ default: m.FilletTool })))
const HoleTool = lazy(() => import('./hole-tool').then((m) => ({ default: m.HoleTool })))
const ThreadTool = lazy(() => import('./thread-tool').then((m) => ({ default: m.ThreadTool })))
const ValuesPanel = lazy(() => import('./values-panel').then((m) => ({ default: m.ValuesPanel })))

// Shape and text on a face

interface PickedFace {
  frame: FaceFrame
  outline: Polygon[]
  target?: { objectId: string; partIndex: number }
  label: string
}

// The typed shapes this tool places, plus the filled outline of an SVG file. Free sketches have their own tool.
type ShapeType = Shape['type'] | 'svg'
const SHAPE_NAMES: Record<ShapeType, string> = { rectangle: 'Rectangle', circle: 'Circle', slot: 'Slot', polygon: 'Polygon', text: 'Text', svg: 'SVG outline' }

function readFont(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('The font file could not be read.'))
    r.readAsDataURL(file)
  })
}

/** A shape step opened from the history, as the fields of the shape tool. */
function shapeEdit(): { index: number; entryId: string; part: number; face: PickedFace; type: ShapeType; f: Record<string, string>; font: string | undefined; svg: { name: string; text: string } | null; operation: 'new' | 'join' | 'cut' } | null {
  const ed = editing()
  const p = ed?.step.params
  if (!ed || p?.op !== 'shape.extrude' || p.shape.type === 'sketch') return null
  const now = nowOf(ed.step, ed.entry.transform)
  const operation = p.spec.operation ?? 'new'
  const frame = p.frame ? now.frame(p.frame) : BED_FRAME
  const sh = p.shape
  const f: Record<string, string> = { x: String(p.placement?.center?.[0] ?? 0), y: String(p.placement?.center?.[1] ?? 0), turn: String(p.placement?.rotationDeg ?? 0), distance: String(p.spec.distanceMm) }
  if (sh.type === 'rectangle') Object.assign(f, { width: String(sh.widthMm), height: String(sh.heightMm), corner: String(sh.cornerRadiusMm ?? 0) })
  if (sh.type === 'slot') Object.assign(f, { width: String(sh.lengthMm), height: String(sh.widthMm) })
  if (sh.type === 'circle') f['diameter'] = String(sh.diameterMm)
  if (sh.type === 'polygon') Object.assign(f, { sides: String(sh.sides), diameter: String(sh.diameterMm) })
  if (sh.type === 'text') Object.assign(f, { text: sh.text, size: String(sh.sizeMm) })
  if (sh.type === 'svg') f['width'] = String(sh.widthMm)
  return {
    index: ed.index,
    entryId: ed.entry.id,
    part: ed.step.part,
    face: { frame, outline: [], ...(operation !== 'new' ? { target: { objectId: ed.entry.id, partIndex: ed.step.part } } : {}), label: `Step ${ed.index + 1} of ${ed.entry.name}` },
    type: sh.type,
    f,
    font: p.font,
    svg: sh.type === 'svg' ? { name: p.name ?? 'SVG outline', text: sh.svg } : null,
    operation,
  }
}

function ShapeTool({ textOnly, svgFirst }: { textOnly: boolean; svgFirst?: boolean }) {
  const host = useHost()
  const [edit] = useState(shapeEdit)
  const v = (k: string, d: string) => edit?.f[k] ?? d
  const [face, setFace] = useState<PickedFace | null>(edit?.face ?? null)
  const [type, setType] = useState<ShapeType>(edit?.type ?? (textOnly ? 'text' : svgFirst ? 'svg' : 'rectangle'))
  const [width, setWidth] = useState(v('width', '20'))
  const [height, setHeight] = useState(v('height', '10'))
  const [corner, setCorner] = useState(v('corner', '0'))
  const [diameter, setDiameter] = useState(v('diameter', '10'))
  const [sides, setSides] = useState(v('sides', '6'))
  const [text, setText] = useState(v('text', appName()))
  const [size, setSize] = useState(v('size', '8'))
  const [font, setFont] = useState<{ name: string; base64: string } | null>(() => {
    const b = edit?.font ? sessionFonts()[edit.font] : undefined
    return edit?.font && b ? { name: edit.font, base64: b } : null
  })
  const [svg, setSvg] = useState<{ name: string; text: string } | null>(edit?.svg ?? null)
  const [installed, setInstalled] = useState<FontChoice[] | null>(null)
  const [x, setX] = useState(v('x', '0'))
  const [y, setY] = useState(v('y', '0'))
  const [turn, setTurn] = useState(v('turn', '0'))
  const [distance, setDistance] = useState(v('distance', textOnly ? '0.6' : '5'))
  const [operation, setOperation] = useState<'new' | 'join' | 'cut'>(edit?.operation ?? 'join')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(edit?.font && !font ? `Pick the font again: ${edit.font} is not loaded.` : null)
  const op = face?.target ? operation : 'new'

  const onPick = useCallback((hit: PickEvent) => {
    setNote(null)
    const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
    const part = e?.parts[hit.partIndex ?? 0]
    if (e && part && hit.point && hit.triangle !== null) {
      void pickFace({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }).then(
        (f) => {
          setFace({ frame: f.frame, outline: f.outline, target: { objectId: e.id, partIndex: hit.partIndex ?? 0 }, label: `A face of ${e.name}` })
          setX(f.at[0].toFixed(2))
          setY(f.at[1].toFixed(2))
        },
        (err: unknown) => setNote(pickWords(err, true)),
      )
    } else if (hit.bed) {
      setFace({ frame: BED_FRAME, outline: [], label: 'The bed' })
      setX(hit.bed[0].toFixed(2))
      setY(hit.bed[1].toFixed(2))
    }
  }, [])
  useProbe(onPick, true)

  const shape = useMemo((): Shape | Extract<FreeShape, { type: 'svg' }> | string => {
    const pos = (v: string) => Number.isFinite(num(v)) && num(v) > 0
    switch (type) {
      case 'rectangle':
        if (!pos(width) || !pos(height)) return 'Width and height must be more than 0 mm.'
        if (!(num(corner) >= 0) || num(corner) * 2 > Math.min(num(width), num(height))) return 'The corner radius is at most half the shorter side.'
        return { type, widthMm: num(width), heightMm: num(height), ...(num(corner) > 0 ? { cornerRadiusMm: num(corner) } : {}) }
      case 'circle':
        return pos(diameter) ? { type, diameterMm: num(diameter) } : 'The diameter must be more than 0 mm.'
      case 'slot':
        if (!pos(width) || !pos(height)) return 'Length and width must be more than 0 mm.'
        return num(width) > num(height) ? { type, lengthMm: num(width), widthMm: num(height) } : 'A slot is longer than it is wide.'
      case 'polygon':
        if (!Number.isInteger(num(sides)) || num(sides) < 3 || num(sides) > 64) return 'A polygon has 3 to 64 sides.'
        return pos(diameter) ? { type, sides: num(sides), diameterMm: num(diameter), fit: 'circumscribed' } : 'The diameter must be more than 0 mm.'
      case 'svg':
        if (!svg) return 'Choose an SVG file.'
        return pos(width) ? { type, svg: svg.text, widthMm: num(width) } : 'The width must be more than 0 mm.'
      case 'text':
        if (!text.trim()) return 'Type the text.'
        return pos(size) ? { type, text: text.trim(), sizeMm: num(size), align: 'center' } : 'The letter height must be more than 0 mm.'
    }
  }, [type, width, height, corner, diameter, sides, text, size, svg])
  const placed = Number.isFinite(num(x)) && Number.isFinite(num(y)) && Number.isFinite(num(turn))
  const depthOk = Number.isFinite(num(distance)) && num(distance) > 0
  const problem = typeof shape === 'string' ? shape : !placed ? 'Position and rotation need numbers.' : !depthOk ? 'The distance must be more than 0 mm.' : null

  // The outline about to be extruded, drawn on the face a moment after the last change.
  useEffect(() => {
    if (!face) return void cameraBus()?.guides?.({})
    const soft = loopsOf(face.frame, face.outline).map((points) => ({ points, soft: true }))
    if (typeof shape === 'string' || !placed) return void cameraBus()?.guides?.({ loops: soft })
    const ac = new AbortController()
    const t = setTimeout(() => {
      shapeProfile(shape, { center: [num(x), num(y)], rotationDeg: num(turn) }, font?.base64, ac.signal).then(
        (polygons) => cameraBus()?.guides?.({ loops: [...soft, ...loopsOf(face.frame, polygons).map((points) => ({ points }))] }),
        (e: unknown) => {
          if (!ac.signal.aborted) setNote(errorText(e))
        },
      )
    }, 120)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [face, shape, placed, x, y, turn, font])

  const apply = async () => {
    if (!face || typeof shape === 'string' || problem) return
    setBusy(true)
    setNote(null)
    try {
      const input: ExtrudeInput = {
        frame: face.frame,
        shape,
        placement: { center: [num(x), num(y)], rotationDeg: num(turn) },
        spec: { distanceMm: num(distance), operation: op },
        ...(face.target ? { target: face.target } : {}),
        ...(font ? { fontBase64: font.base64, fontName: font.name } : {}),
        name: shape.type === 'text' ? shape.text.slice(0, 24) : shape.type === 'svg' ? (svg?.name.replace(/\.svg$/i, '').slice(0, 24) || 'SVG outline') : SHAPE_NAMES[shape.type],
      }
      bindNext(distance)
      if (edit) {
        await saveEdit(host.slicer, extrudeParams(input))
        toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applyExtrude(host.slicer, input)
      toast(r.message, r.warn ? 'warn' : 'ok')
      // The mesh under the face changed, so the face is picked again for the next shape.
      setFace(null)
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const first = type === 'slot' ? 'Length' : 'Width'
  const second = type === 'slot' ? 'Width' : 'Height'
  return (
    <Shell title={textOnly ? 'Text on a face' : 'Shape on a face'} aside={edit ? `Editing step ${edit.index + 1}` : face ? face.label : 'No face yet'}>
      {!face ? <p className="cad-hint"><Icon name="mouse-left" size={15} /> Click a flat face, or the bed, where the {textOnly ? 'text' : 'shape'} goes.</p> : null}
      {!textOnly ? (
        <Field htmlFor="cad-shape" label="Shape">
          <Select id="cad-shape" value={type} onChange={(e) => setType(e.target.value as ShapeType)}>
            {(Object.keys(SHAPE_NAMES) as ShapeType[]).map((t) => (
              <option key={t} value={t}>{SHAPE_NAMES[t]}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      {type === 'text' ? (
        <>
          <Field htmlFor="cad-text" label="Text">
            <Input id="cad-text" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="cad-pair">
            <Num id="cad-size" label="Letter height" unit="mm" value={size} onChange={setSize} />
            <Field htmlFor="cad-font" label="Font" hint={font ? font.name : 'Built in'}>
              <label className="cad-file">
                <input
                  id="cad-font"
                  type="file"
                  accept=".ttf,.otf,font/ttf,font/otf"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void readFont(f).then((base64) => setFont({ name: f.name, base64 }), (err: unknown) => setNote(errorText(err)))
                  }}
                />
                <span>Choose a TTF or OTF</span>
              </label>
            </Field>
          </div>
          {localFontsAvailable() ? (
            installed === null ? (
              <Button size="sm" variant="ghost" icon="text" onClick={() => void listLocalFonts().then((list) => (list.length ? setInstalled(list) : setNote('No installed fonts were offered. Choose a TTF or OTF file instead.')))}>
                Use an installed font
              </Button>
            ) : (
              <Field htmlFor="cad-installed" label="Installed font">
                <Select
                  id="cad-installed"
                  value={font?.name ?? ''}
                  onChange={(e) => {
                    const c = installed.find((f) => f.family === e.target.value)
                    if (c) void fontBase64(c).then((base64) => setFont({ name: c.family, base64 }), (err: unknown) => setNote(errorText(err)))
                    else setFont(null)
                  }}
                >
                  <option value="">Built in</option>
                  {installed.map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.family}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : null}
        </>
      ) : type === 'svg' ? (
        <>
          <SvgFileField id="cad-svg" file={svg} onFile={(f) => { setSvg(f); setNote(null) }} onError={setNote} />
          <Num id="cad-w" label="Width" unit="mm" value={width} onChange={setWidth} />
          <p className="cad-hint">All fill colors become one outline, centered on the position, the top of the artwork along the face's up direction.</p>
        </>
      ) : type === 'circle' ? (
        <Num id="cad-dia" label="Diameter" unit="mm" value={diameter} onChange={setDiameter} />
      ) : type === 'polygon' ? (
        <div className="cad-pair">
          <Num id="cad-sides" label="Sides" unit="" value={sides} onChange={setSides} />
          <Num id="cad-dia" label="Across flats" unit="mm" value={diameter} onChange={setDiameter} />
        </div>
      ) : (
        <>
          <div className="cad-pair">
            <Num id="cad-w" label={first} unit="mm" value={width} onChange={setWidth} />
            <Num id="cad-h" label={second} unit="mm" value={height} onChange={setHeight} />
          </div>
          {type === 'rectangle' ? <Num id="cad-corner" label="Corner radius" unit="mm" value={corner} onChange={setCorner} /> : null}
        </>
      )}
      <Vec id="cad" label="Center" ariaLabel="Shape center" unit="mm" axes={['x', 'y']} values={[x, y]} onChange={[setX, setY]} />
      <Num id="cad-turn" label="Turn" unit={'°'} value={turn} onChange={setTurn} />
      <div className="cad-row">
        <span>Result</span>
        <Seg
          label="Result"
          size="sm"
          value={op}
          onChange={setOperation}
          options={[
            { value: 'join', label: 'Join', disabled: !face?.target },
            { value: 'cut', label: 'Cut', disabled: !face?.target },
            { value: 'new', label: 'New body' },
          ]}
        />
      </div>
      <Num id="cad-dist" label={op === 'cut' ? 'Depth into the face' : 'Height off the face'} unit="mm" value={distance} onChange={setDistance} />
      {note || (face && problem) ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note ?? problem}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={close} disabled={busy}>Done</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || !face || problem !== null}>
          {busy ? 'Working' : op === 'cut' ? 'Cut' : op === 'join' ? 'Join' : 'Add body'}
        </Button>
      </div>
    </Shell>
  )
}

// Arrays

function ArrayTool() {
  const host = useHost()
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const bed = useApp((s) => s.bed)
  const box = useMemo(() => (entry ? bounds(entry.parts, entry.transform) : null), [entry])
  const [kind, setKind] = useState<ArrayKind>('linear')
  const [count, setCount] = useState('3')
  const [rows, setRows] = useState('2')
  const [sx, setSx] = useState(() => (box ? (box.max[0] - box.min[0] + 5).toFixed(1) : '30'))
  const [sy, setSy] = useState('0')
  const [sz, setSz] = useState('0')
  const [gy, setGy] = useState(() => (box ? (box.max[1] - box.min[1] + 5).toFixed(1) : '30'))
  // The circle's center starts beside the object, far enough that the default copies do not overlap.
  const reach = box ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) * 1.2 + 10 : 60
  const [cx, setCx] = useState(() => (box ? (box.min[0] + box.max[0]) / 2 - reach : bed.widthMm / 2).toFixed(1))
  const [cy, setCy] = useState(() => (box ? (box.min[1] + box.max[1]) / 2 : bed.depthMm / 2).toFixed(1))
  const [angle, setAngle] = useState('360')
  const [rotate, setRotate] = useState(true)
  const [merge, setMerge] = useState<'copies' | 'merged'>('copies')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ count: number; overlapping: boolean } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Clicks do nothing here; probe mode keeps a stray drag from moving the object under its preview.
  useProbe(() => undefined, false)

  const spec = useMemo(
    () => arraySpec({ kind, count: num(count), rows: num(rows), step: kind === 'grid' ? [num(sx), num(gy), 0] : [num(sx), num(sy), num(sz)], center: [num(cx), num(cy)], angleDeg: num(angle), rotateCopies: rotate }),
    [kind, count, rows, sx, sy, sz, gy, cx, cy, angle, rotate],
  )
  useEffect(() => {
    setPreview(null)
    if (!entry || typeof spec === 'string') return void cameraBus()?.guides?.({})
    const ac = new AbortController()
    const t = setTimeout(() => {
      previewArray(entry, spec, ac.signal).then(
        (r) => {
          setPreview({ count: r.transforms.length, overlapping: r.overlapping })
          cameraBus()?.guides?.({ loops: r.footprints.map((points, i) => ({ points, soft: i === 0 })) })
        },
        (e: unknown) => {
          if (!ac.signal.aborted) setNote(errorText(e))
        },
      )
    }, 150)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [entry, spec])

  const apply = async () => {
    if (!entry || typeof spec === 'string') return
    setBusy(true)
    setNote(null)
    try {
      const n = await applyArray(host.slicer, entry.id, spec, merge === 'merged')
      toast(merge === 'merged' ? `Merged ${n} copies into ${entry.name}.` : `Made ${n - 1} copies of ${entry.name}.`, 'ok')
      close()
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const problem = !entry ? 'Select the object to copy.' : typeof spec === 'string' ? spec : null
  return (
    <Shell title="Array" aside={entry ? entry.name : 'Nothing selected'}>
      <Seg label="Array type" size="sm" full value={kind} onChange={setKind} options={[{ value: 'linear', label: 'Line' }, { value: 'grid', label: 'Grid' }, { value: 'circular', label: 'Circle' }]} />
      {kind === 'linear' ? (
        <>
          <Num id="arr-count" label="Copies, the original included" unit="" value={count} onChange={setCount} />
          <Vec id="arr-s" label="Spacing" unit="mm" axes={['x', 'y', 'z']} values={[sx, sy, sz]} onChange={[setSx, setSy, setSz]} />
        </>
      ) : kind === 'grid' ? (
        <>
          <div className="cad-pair">
            <Num id="arr-count" label="Columns" unit="" value={count} onChange={setCount} />
            <Num id="arr-rows" label="Rows" unit="" value={rows} onChange={setRows} />
          </div>
          <div className="cad-pair">
            <Num id="arr-sx" label="Column spacing" unit="mm" value={sx} onChange={setSx} />
            <Num id="arr-gy" label="Row spacing" unit="mm" value={gy} onChange={setGy} />
          </div>
        </>
      ) : (
        <>
          <div className="cad-pair">
            <Num id="arr-count" label="Copies" unit="" value={count} onChange={setCount} />
            <Num id="arr-angle" label="Over" unit={'°'} value={angle} onChange={setAngle} />
          </div>
          <Vec id="arr-c" label="Center" ariaLabel="Array center" unit="mm" axes={['x', 'y']} values={[cx, cy]} onChange={[setCx, setCy]} />
          <div className="cad-row">
            <label htmlFor="arr-rotate">Turn each copy to face the center</label>
            <Switch id="arr-rotate" checked={rotate} onChange={setRotate} label="Turn each copy to face the center" />
          </div>
        </>
      )}
      <div className="cad-row">
        <span>Result</span>
        <Seg label="Result" size="sm" value={merge} onChange={setMerge} options={[{ value: 'copies', label: 'Copies' }, { value: 'merged', label: 'One object' }]} />
      </div>
      {problem || note ? (
        <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note ?? problem}</p>
      ) : preview ? (
        <p className={preview.overlapping ? 'cad-note' : 'cad-hint'} role="status">
          <Icon name={preview.overlapping ? 'alert' : 'grid'} size={14} />{' '}
          {preview.overlapping ? (merge === 'merged' ? `${preview.count} copies that overlap: they fuse into one piece.` : `${preview.count} copies that overlap. Widen the spacing, or merge them into one object.`) : `${preview.count} copies, outlined on the bed.`}
        </p>
      ) : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || problem !== null}>
          {busy ? 'Working' : merge === 'merged' ? 'Merge copies' : 'Make copies'}
        </Button>
      </div>
    </Shell>
  )
}

// Measure

function MeasureTool() {
  const [picks, setPicks] = useState<Feature[]>([])
  const [result, setResult] = useState<Measurement | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [kind, setKind] = useState<DimensionKind | null>(null)
  const [keeping, setKeeping] = useState(false)
  const current = useRef<Feature[]>([])
  // Where each pick landed on an object, for keeping the dimension; null for the bed.
  const hits = useRef<(ObjectPick | null)[]>([])
  const showAll = useApp((s) => s.showDimensions)
  const plate = useApp((s) => s.plate)
  const selection = useApp((s) => s.selection)
  const results = useDimensionResults()

  const onPick = useCallback((hit: PickEvent) => {
    setNote(null)
    const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
    const part = e?.parts[hit.partIndex ?? 0]
    const found: Promise<Feature | null> =
      e && part && hit.point && hit.triangle !== null
        ? featureAt({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }, 1.5)
        : Promise.resolve(hit.bed ? { kind: 'plane', point: [hit.bed[0], hit.bed[1], 0], normal: [0, 0, 1], areaMm2: 0 } : null)
    void found.then(
      (f) => {
        if (!f) return
        // A third click starts a new measurement.
        const next = current.current.length >= 2 ? [f] : [...current.current, f]
        const where: ObjectPick | null = e && hit.point && hit.triangle !== null ? { objectId: e.id, partIndex: hit.partIndex ?? 0, triangle: hit.triangle, at: hit.point } : null
        hits.current = current.current.length >= 2 ? [where] : [...hits.current, where]
        current.current = next
        setPicks(next)
        setResult(null)
        void measure(next[0]!, next[1]).then(
          (m) => current.current === next && setResult(m),
          (err: unknown) => current.current === next && setNote(errorText(err)),
        )
      },
      (err: unknown) => setNote(errorText(err)),
    )
  }, [])
  useProbe(onPick, false)

  useEffect(() => {
    const points: Vec3[] = picks.flatMap(featurePoints)
    const lines = picks.flatMap((f) => (f.kind === 'edge' ? [{ from: f.a, to: f.b }] : []))
    if (result?.from && result.to) {
      lines.push({ from: result.from, to: result.to })
      points.push(result.from, result.to)
    }
    cameraBus()?.guides?.({ lines, points })
  }, [picks, result])

  const clear = () => {
    current.current = []
    hits.current = []
    setPicks([])
    setResult(null)
    setNote(null)
  }
  const rows = result ? readout(result) : []
  const kinds = result ? keepableKinds(picks, result.distanceMm !== undefined, result.angleDeg !== undefined && !result.parallel) : []
  const keepKind = kind && kinds.includes(kind) ? kind : (kinds[0] ?? null)
  const onBed = picks.length > 0 && hits.current.length === picks.length && hits.current.some((h) => h === null)
  const keep = async () => {
    if (!keepKind || !result || onBed) return
    const value = { distance: result.distanceMm, angle: result.angleDeg, radius: result.radiusMm, diameter: result.diameterMm, length: result.lengthMm }[keepKind]
    setKeeping(true)
    try {
      await keepDimension(keepKind, hits.current.filter((h): h is ObjectPick => h !== null), value)
      toast(`Kept the ${KIND_NAMES[keepKind].toLowerCase()} on the model.`, 'ok')
    } catch (err) {
      setNote(errorText(err))
    } finally {
      setKeeping(false)
    }
  }
  // Kept dimensions of the selected object, or of every object with the toggle on.
  const kept = plate.flatMap((e) => (showAll || e.id === selection ? (e.dimensions ?? []).map((d) => ({ d, owner: e.name })) : []))
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(label)
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400)
    }, () => undefined)
  }
  return (
    <Shell title="Measure" aside={picks.length === 2 ? 'Between two picks' : picks.length === 1 ? 'One pick' : 'Nothing picked'}>
      <p className="cad-hint">
        <Icon name="mouse-left" size={15} /> {picks.length === 0 ? 'Click a corner, an edge, a hole or a face. The bed counts too.' : picks.length === 1 ? 'Click a second one for the distance and the angle between them.' : 'Click again to start a new measurement.'}
      </p>
      {picks.length ? (
        <ol className="cad-picks">
          {picks.map((f, i) => (
            <li key={i}><span className="cad-pick-n">{i + 1}</span> {describeFeature(f)}</li>
          ))}
        </ol>
      ) : null}
      {rows.length ? (
        <dl className="cad-readout">
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>
                <button type="button" className="cad-value sx-mono" aria-label={`Copy ${r.label.toLowerCase()}, ${r.value}`} onClick={() => copy(r.label, r.copy)}>
                  {copied === r.label ? 'Copied' : r.value}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {keepKind && !onBed ? (
        <div className="cad-row">
          {kinds.length > 1 ? <Seg label="Dimension to keep" size="sm" value={keepKind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: KIND_NAMES[k] }))} /> : <span>{KIND_NAMES[keepKind]}</span>}
          <Button size="sm" variant="ghost" icon="pin" data-tip="cad.keepDimension" onClick={() => void keep()} disabled={keeping}>Keep this dimension</Button>
        </div>
      ) : onBed && kinds.length ? (
        <p className="cad-hint"><Icon name="info" size={15} /> A dimension to the bed cannot be kept. Pick places on objects to keep one.</p>
      ) : null}
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <div className="cad-row">
        <label htmlFor="dim-show">Show all kept dimensions</label>
        <Switch id="dim-show" checked={showAll} onChange={(v) => set({ showDimensions: v })} label="Show all kept dimensions" />
      </div>
      {kept.length ? (
        <ul className="cad-kept" aria-label="Kept dimensions">
          {kept.map(({ d, owner }) => {
            const text = dimensionText(d, results[d.id])
            return (
              <li key={d.id} data-lost={text === 'Lost' ? true : undefined}>
                <span>{KIND_NAMES[d.kind]}{showAll ? `, ${owner}` : ''}</span>
                <span className="sx-mono">{text === 'Lost' ? `Lost: ${results[d.id]?.message ?? 'the place it was kept on is gone.'}` : text}</span>
                <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove the ${KIND_NAMES[d.kind].toLowerCase()}`} onClick={() => removeDimension(d.id)}>Remove</Button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={clear} disabled={picks.length === 0}>Clear</Button>
        <Button variant="primary" onClick={close}>Done</Button>
      </div>
    </Shell>
  )
}

let panels = 0

export function CadPanel({ tool }: { tool: CadTool }) {
  // The panel lives in the settings sidebar, so the sidebar opens with the tool.
  useEffect(() => {
    set((s) => (s.rails['prepare']?.left === false ? { rails: { ...s.rails, prepare: { ...s.rails['prepare'], left: true } } } : {}))
    // A history step opened in this panel closes with it, unless it was saved. Checked a moment later,
    // so a panel that mounts again at once (the next tool, development double mounts) keeps it.
    const mine = get().historyEdit
    panels++
    return () => {
      panels--
      setTimeout(() => {
        if (mine && panels === 0 && get().historyEdit === mine) cancelEdit()
      }, 0)
    }
  }, [])
  if (tool === 'array') return <ArrayTool />
  if (tool === 'measure') return <MeasureTool />
  if (tool === 'sketch') return <Suspense fallback={null}><SketchTool /></Suspense>
  if (tool === 'push') return <Suspense fallback={null}><PushTool /></Suspense>
  if (tool === 'fillet') return <Suspense fallback={null}><FilletTool /></Suspense>
  if (tool === 'holefit') return <Suspense fallback={null}><HoleTool /></Suspense>
  if (tool === 'thread') return <Suspense fallback={null}><ThreadTool /></Suspense>
  if (tool === 'values') return <Suspense fallback={null}><ValuesPanel /></Suspense>
  return <ShapeTool textOnly={tool === 'facetext'} svgFirst={tool === 'facesvg'} />
}
