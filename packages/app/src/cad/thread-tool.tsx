// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The thread tool: click the wall of a round hole or the side of a rod or boss, pick an ISO size (the one that
// suits it comes first), and the thread is cut in place as a step of the object's history. The clearance is the
// measured fit (plate/clearance.ts), at most a quarter of the pitch (thread-spec.ts).
import type { PickEvent } from '@slicerx/viewport'
import { Button, Icon, Select } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { threadFind, type ThreadTarget } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { clearanceFor } from '../plate/clearance'
import { cameraBus } from '../plate/tools'
import { get, set, toast, useApp } from '../state/store'
import { edgeLines } from './edges'
import { applyThread } from './holes'
import { editing, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { close, errorText, num, Num, Shell, useProbe } from './panel-kit'
import { threadSpecFor } from './thread-spec'

interface Picked {
  objectId: string
  partIndex: number
  target: ThreadTarget
}

const mm = (v: number) => `${Number(v.toFixed(2))} mm`

/** The rim the thread starts at, to draw. */
function rimOf(t: ThreadTarget) {
  const [x, y, z] = t.axis
  const [a0, a1, a2] = Math.abs(z) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const c: [number, number, number] = [y * a2 - z * a1, z * a0 - x * a2, x * a1 - y * a0]
  const l = Math.hypot(c[0], c[1], c[2]) || 1
  const r = t.diameterMm / 2
  const p: [number, number, number] = [t.start[0] + (c[0] / l) * r, t.start[1] + (c[1] / l) * r, t.start[2] + (c[2] / l) * r]
  return edgeLines({ a: p, b: p, face: t.axis, center: t.start })
}

export function ThreadTool() {
  const host = useHost()
  const edit = (() => {
    const ed = editing()
    const p = ed?.step.params
    return ed && p?.op === 'thread.apply' ? { index: ed.index, objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part), params: p } : null
  })()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [size, setSize] = useState(edit?.params.spec.size ?? '')
  const [length, setLength] = useState(edit?.params.spec.lengthMm !== undefined ? String(edit.params.spec.lengthMm) : '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fitMm = useApp((s) => clearanceFor(s).mm)
  const fitWords = useApp((s) => clearanceFor(s).words)
  const fitMeasured = useApp((s) => clearanceFor(s).measured)

  useEffect(() => {
    cameraBus()?.guides?.({ lines: picked ? rimOf(picked.target) : [], points: [] })
    return () => cameraBus()?.guides?.({ lines: [], points: [] })
  }, [picked])

  const find = useCallback((objectId: string, partIndex: number, triangle: number, at: [number, number, number]) => {
    const e = get().plate.find((p) => p.id === objectId)
    const part = e?.parts[partIndex]
    if (!e || !part) return
    setNote(null)
    threadFind({ mesh: toGeom(part), transform: e.transform }, { triangle, at }).then(
      (target) => {
        setPicked({ objectId, partIndex, target })
        setSize(target.suggested)
      },
      (err: unknown) => setNote(errorText(err)),
    )
  }, [])

  const onPick = useCallback((hit: PickEvent) => {
    if (!hit.objectId || hit.triangle === null || !hit.point) return
    find(hit.objectId, hit.partIndex ?? 0, hit.triangle, hit.point)
  }, [find])
  useProbe(onPick, false)

  // Editing a step: the sizes come with a find, so the list shows once the hole or rod is clicked again.
  const sizes = picked?.target.sizes ?? []
  const lengthMm = length.trim() === '' ? undefined : num(length)
  const fit = { mm: fitMm, measured: fitMeasured, words: fitWords }
  const target: ThreadTarget | null = picked?.target ?? (edit ? { ...edit.params.thread, suggested: edit.params.spec.size, sizes: [] } : null)
  const sized = picked && size ? threadSpecFor(picked.target, lengthMm === undefined ? { size } : { size, lengthMm }, fit) : null

  const apply = async () => {
    if (busy || !target) return
    setBusy(true)
    setNote(null)
    try {
      const { suggested: _s, sizes: _all, ...place } = target
      bindNext(length)
      if (edit) {
        const spec = sized?.spec ?? { ...edit.params.spec, ...(lengthMm !== undefined ? { lengthMm } : {}) }
        await saveEdit(host.slicer, { op: 'thread.apply', thread: place, spec, label: sized?.label ?? edit.params.label })
        toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
        set({ objectTool: null })
        return
      }
      if (!picked || !sized) return
      const r = await applyThread(host.slicer, picked.objectId, picked.partIndex, { op: 'thread.apply', thread: place, spec: sized.spec, label: sized.label })
      toast(r.message, r.warn ? 'warn' : 'ok')
      setPicked(null)
    } catch (err) {
      setNote(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const t = target
  return (
    <Shell title="Thread" aside={edit ? `Editing step ${edit.index + 1}` : t ? `${t.internal ? 'Hole' : 'Rod'} ${mm(t.diameterMm)}, ${mm(t.lengthMm)} long` : 'Nothing picked yet'}>
      <p className="cad-hint"><Icon name="mouse-left" size={15} /> {t ? 'Click another hole or rod to thread that one instead.' : 'Click the wall of a round hole, or the side of a rod or boss.'}</p>
      {sizes.length ? (
        <div className="cad-row">
          <span>Size</span>
          <Select id="thread-size" aria-label="Thread size" value={size} onChange={(ev) => setSize(ev.target.value)}>
            {sizes.map((s) => (
              <option key={s.name} value={s.name}>{`${s.name} x ${s.pitchMm}`}</option>
            ))}
          </Select>
        </div>
      ) : edit ? (
        <p className="cad-hint">{edit.params.label}. Click the hole or rod again to pick another size.</p>
      ) : null}
      {t ? (
        <div className="cad-pair">
          <Num id="thread-length" label="Length" unit="mm" value={length} onChange={setLength} onEnter={() => void apply()} />
        </div>
      ) : null}
      {sized ? (
        <div className="cad-hint" data-testid="thread-words">
          {sized.words.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={() => (picked && !edit ? setPicked(null) : close())} disabled={busy}>{picked && !edit ? 'Clear' : 'Done'}</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || !(sized || edit)}>
          {busy ? 'Working' : 'Cut thread'}
        </Button>
      </div>
    </Shell>
  )
}
