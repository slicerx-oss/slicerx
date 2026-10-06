// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The push and pull tool's panel. Hover lights the flat face under the cursor; a click picks it and a
// drag moves it, in the view (viewport cadtools.ts stretches a 1 mm prism, no boolean) or by the
// typed distance. The field and the drag stay in step. The push itself runs once, on release or Enter.
import type { PickEvent, PushEvent } from '@slicerx/viewport'
import { Button, Icon } from '@slicerx/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { pushPreview, type Vec3 } from '../geom/cad'
import type { GeomMesh } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { get, set, toast } from '../state/store'
import { findTriangle } from './history/model'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { loopsOf } from './cad-ops'
import { close, errorText, Num, pickWords, Shell, useProbe } from './panel-kit'
import { applyPush, onFace, parseDistance, pickPushFace, pushWords, type PushFace } from './push'

export function PushTool() {
  const host = useHost()
  const [face, setFace] = useState<PushFace | null>(null)
  const [text, setText] = useState('')
  const [prism, setPrism] = useState<GeomMesh | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // The handlers below run outside React's render: they read the latest values from here.
  const live = useRef({ face, text, busy, picking: null as Promise<PushFace | null> | null })
  live.current = { ...live.current, face, text, busy }
  const view = cameraBus()?.cad
  const distance = parseDistance(text)
  // A typed distance can follow a named value; a dragged one is a plain number.
  const typed = (go: () => Promise<void>) => {
    bindNext(text)
    void go().finally(() => bindNext(undefined))
  }
  // A push step opened from the history: its face, found again on the part as it was before the step.
  const [edit] = useState(() => {
    const ed = editing()
    return ed && ed.step.params.op === 'face.push' ? ed : null
  })

  const pick = useCallback((objectId: string, partIndex: number, triangle: number, at: Vec3): Promise<PushFace | null> => {
    setNote(null)
    const p = pickPushFace(objectId, partIndex, { triangle, at }).then(
      (f) => {
        setFace(f)
        return f
      },
      (e: unknown) => {
        const words = pickWords(e)
        if (words) setNote(words)
        return null
      },
    )
    live.current.picking = p
    return p
  }, [])

  const onPick = useCallback(
    (hit: PickEvent) => {
      if (live.current.busy) return
      if (hit.objectId && hit.point && hit.triangle !== null) {
        setText('')
        void pick(hit.objectId, hit.partIndex ?? 0, hit.triangle, hit.point)
      } else if (hit.bed) setNote('The bed does not move. Pick a flat face on an object.')
    },
    [pick],
  )
  useProbe(onPick, true)

  useEffect(() => {
    if (!edit || edit.step.params.op !== 'face.push') return
    const now = nowOf(edit.step, edit.entry.transform)
    const at = now.point(edit.step.params.at)
    const part = get().plate.find((p) => p.id === edit.entry.id)?.parts[edit.step.part]
    const tri = part ? findTriangle(part, edit.entry.transform, at, now.dir(edit.step.params.normal)) : -1
    setText(String(edit.step.params.distanceMm))
    if (tri < 0) setNote('The face this step moved is not there before it any more. Pick a face to push instead.')
    else void pick(edit.entry.id, edit.step.part, tri, at)
  }, [edit, pick])

  const apply = useCallback(
    async (d: number | null, f: PushFace | null) => {
      if (!f || d === null || d === 0 || live.current.busy) return
      setBusy(true)
      live.current.busy = true
      setNote(null)
      try {
        if (edit) {
          // The step takes the new face and distance; the steps after it run again.
          await saveEdit(host.slicer, { op: 'face.push', at: f.pick.at, normal: f.frame.normal, distanceMm: d })
          toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
          set({ objectTool: null })
          return
        }
        const r = await applyPush(host.slicer, f, d)
        toast(r.message, r.warn ? 'warn' : 'ok')
        // The mesh changed under the face, so the next push starts from a new pick.
        setFace(null)
        setText('')
      } catch (e) {
        setNote(errorText(e))
      } finally {
        live.current.busy = false
        setBusy(false)
      }
    },
    [host, edit],
  )

  // The prism for a 1 mm push; the view stretches it, so a drag asks the engine for nothing.
  useEffect(() => {
    setPrism(null)
    if (!face) return
    const ac = new AbortController()
    pushPreview(face, 1, ac.signal).then(
      (r) => !ac.signal.aborted && setPrism(r.tool),
      () => undefined,
    )
    return () => ac.abort()
  }, [face])

  useEffect(() => {
    view?.setPush({ face: face ? { objectId: face.objectId, point: face.pick.at, normal: face.frame.normal } : null, distanceMm: distance ?? 0, prism })
    cameraBus()?.guides?.(face ? { loops: loopsOf(face.frame, face.outline).map((points) => ({ points })) } : {})
  }, [view, face, distance, prism])
  useEffect(() => () => view?.setPush(null), [view])

  // Drags in the view. Moves update the field at most once a frame.
  useEffect(() => {
    if (!view) return
    let frame = 0
    let latest = ''
    return view.on('push', (e: PushEvent) => {
      const f = live.current.face
      const same = f !== null && f.objectId === e.objectId && onFace(f, e.point, e.normal)
      if (e.phase === 'start') {
        if (!same) void pick(e.objectId, e.partIndex, e.triangle, e.point)
        else live.current.picking = Promise.resolve(f)
      }
      if (e.phase === 'move' || e.phase === 'cancel') {
        latest = e.distanceMm === 0 ? '' : String(e.distanceMm)
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0
          setText(latest)
        })
      }
      if (e.phase === 'end') {
        setText(String(e.distanceMm))
        void (live.current.picking ?? Promise.resolve(f)).then((picked) => apply(e.distanceMm, picked))
      }
    })
  }, [view, pick, apply])

  const words = face ? pushWords(distance, face.thicknessMm) : null
  const bad = text.trim() !== '' && distance === null
  return (
    <Shell title="Push and pull" aside={edit ? `Editing step ${edit.index + 1}` : face ? 'A face is picked' : 'No face yet'}>
      {!face ? (
        <p className="cad-hint"><Icon name="mouse-left" size={15} /> Click a flat face, or drag one in or out. Hold Shift to move in 1 mm steps.</p>
      ) : (
        <p className="cad-hint" role="status"><Icon name="info" size={15} /> {words}</p>
      )}
      <Num id="push-dist" label="Distance along the face normal" unit="mm" value={text} onChange={setText} onEnter={() => typed(() => apply(distance, face))} />
      {note || bad ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note ?? 'Type a number, such as 5 or -3.'}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={close} disabled={busy}>Done</Button>
        <Button variant="primary" onClick={() => typed(() => apply(distance, face))} disabled={busy || !face || !distance}>
          {busy ? 'Working' : distance !== null && distance < 0 ? 'Push in' : 'Pull out'}
        </Button>
      </div>
    </Shell>
  )
}
