// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hole tool: click the wall of a round hole, say what it is for (a screw that passes, a screw that cuts its
// own thread, a heat-set insert, or a size), and the hole becomes that size in place, with a counterbore or a
// countersink for the head, as a step of the object's history. Clearance holes take the measured fit
// (plate/clearance.ts); the other sizes come from a table of usual ones (hole-sizes.ts).
import type { PickEvent } from '@slicerx/viewport'
import { Button, Icon, Seg, Select } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { holeFind, type Hole } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { clearanceFor } from '../plate/clearance'
import { cameraBus } from '../plate/tools'
import { get, set, toast, useApp } from '../state/store'
import { edgeLines } from './edges'
import { holeSpecFor, THREADS, type Head, type Purpose, type Thread } from './hole-sizes'
import { applyHole } from './holes'
import { editing, saveEdit } from './history/ops'
import { close, errorText, num, Num, Shell, useProbe } from './panel-kit'

interface Picked {
  objectId: string
  partIndex: number
  hole: Hole
}

const mm = (v: number) => `${Number(v.toFixed(2))} mm`

/** The hole's entry rim, to draw. */
function rimOf(h: Hole) {
  const [x, y, z] = h.axis
  const [a0, a1, a2] = Math.abs(z) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const c: [number, number, number] = [y * a2 - z * a1, z * a0 - x * a2, x * a1 - y * a0]
  const l = Math.hypot(c[0], c[1], c[2]) || 1
  const r = h.diameterMm / 2
  const p: [number, number, number] = [h.entry[0] + (c[0] / l) * r, h.entry[1] + (c[1] / l) * r, h.entry[2] + (c[2] / l) * r]
  return edgeLines({ a: p, b: p, face: h.axis, center: h.entry })
}

export function HoleTool() {
  const host = useHost()
  const edit = (() => {
    const ed = editing()
    const p = ed?.step.params
    return ed && p?.op === 'hole.apply' ? { index: ed.index, objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part), params: p } : null
  })()
  const [picked, setPicked] = useState<Picked | null>(edit ? { objectId: edit.objectId, partIndex: edit.partIndex, hole: edit.params.hole } : null)
  const [purpose, setPurpose] = useState<Purpose>(edit ? 'custom' : 'clearance')
  const [thread, setThread] = useState<Thread>('M3')
  const [head, setHead] = useState<Head>('none')
  const [custom, setCustom] = useState(edit ? String(edit.params.spec.diameterMm) : '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fitMm = useApp((s) => clearanceFor(s).mm)
  const fitWords = useApp((s) => clearanceFor(s).words)
  const fitMeasured = useApp((s) => clearanceFor(s).measured)

  useEffect(() => {
    cameraBus()?.guides?.({ lines: picked ? rimOf(picked.hole) : [], points: [] })
    return () => cameraBus()?.guides?.({ lines: [], points: [] })
  }, [picked])

  const onPick = useCallback((hit: PickEvent) => {
    if (!hit.objectId || hit.triangle === null || !hit.point) return
    const objectId = hit.objectId
    const partIndex = hit.partIndex ?? 0
    const e = get().plate.find((p) => p.id === objectId)
    const part = e?.parts[partIndex]
    if (!e || !part) return
    setNote(null)
    holeFind({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }).then(
      (hole) => setPicked({ objectId, partIndex, hole }),
      (err: unknown) => setNote(errorText(err)),
    )
  }, [])
  useProbe(onPick, false)

  const customMm = num(custom)
  const choice = purpose === 'custom' ? { purpose, thread, head, customMm } : { purpose, thread, head }
  const ready = picked !== null && (purpose !== 'custom' || (Number.isFinite(customMm) && customMm > 0))
  const sized = picked && ready ? holeSpecFor(choice, { mm: fitMm, measured: fitMeasured, words: fitWords }, picked.hole) : null

  const apply = async () => {
    if (!picked || !sized || busy) return
    setBusy(true)
    setNote(null)
    try {
      const params = { op: 'hole.apply' as const, hole: picked.hole, spec: sized.spec, label: sized.label }
      if (edit) {
        await saveEdit(host.slicer, params)
        toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applyHole(host.slicer, picked.objectId, picked.partIndex, params)
      toast(r.message, r.warn ? 'warn' : 'ok')
      setPicked(null)
    } catch (err) {
      setNote(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const h = picked?.hole
  return (
    <Shell title="Hole" aside={edit ? `Editing step ${edit.index + 1}` : h ? `${mm(h.diameterMm)}, ${h.through ? 'through' : `${mm(h.depthMm)} deep`}` : 'No hole yet'}>
      <p className="cad-hint"><Icon name="mouse-left" size={15} /> {h ? 'Click another hole to change that one instead.' : 'Click the wall of a round hole.'}</p>
      <Seg
        label="What the hole is for"
        size="sm"
        full
        value={purpose}
        onChange={setPurpose}
        options={[
          { value: 'clearance', label: 'Screw passes' },
          { value: 'tap', label: 'Screw threads in' },
          { value: 'insert', label: 'Insert' },
          { value: 'custom', label: 'Size' },
        ]}
      />
      {purpose === 'custom' ? (
        <div className="cad-pair">
          <Num id="hole-diameter" label="Diameter" unit="mm" value={custom} onChange={setCustom} onEnter={() => void apply()} />
        </div>
      ) : (
        <div className="cad-row">
          <span>Screw</span>
          <Select id="hole-thread" aria-label="Screw size" value={thread} onChange={(ev) => setThread(ev.target.value as Thread)}>
            {THREADS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>
      )}
      {purpose === 'clearance' ? (
        <div className="cad-row">
          <span>Head</span>
          <Seg label="Screw head" size="sm" value={head} onChange={setHead} options={[{ value: 'none', label: 'None' }, { value: 'counterbore', label: 'Counterbore' }, { value: 'countersink', label: 'Countersink' }]} />
        </div>
      ) : null}
      {sized ? (
        <div className="cad-hint" data-testid="hole-size-words">
          {sized.words.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={() => (picked && !edit ? setPicked(null) : close())} disabled={busy}>{picked && !edit ? 'Clear' : 'Done'}</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || !sized}>
          {busy ? 'Working' : 'Make hole'}
        </Button>
      </div>
    </Shell>
  )
}
