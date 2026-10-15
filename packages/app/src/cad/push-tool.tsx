// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The push and pull tool. Hover lights the flat face under the cursor; a click picks it and a drag moves it, in the
// view (viewport cadtools.ts stretches a 1 mm prism, no boolean), on the arrow (push-in-view.tsx) or by the typed
// distance. The tool's state lives with the view (usePushTool, mounted by push-in-view.tsx), so it works with the right
// pane shut; the panel here shows the same state (push-session.ts). The push itself runs once, on release or Enter.
import type { PickEvent, PushEvent } from '@slicerx/viewport'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushPreview, type Vec3 } from '../geom/cad'
import type { GeomMesh } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { get, set, toast, useApp, type SubPick } from '../state/store'
import { findTriangle } from '@slicerx/cad-history'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { loopsOf } from './cad-ops'
import { errorText, Message, Note, Num, pickWords, PointerHint, Shell, useProbe, ToolFooter } from './panel-kit'
import { follow, useDraft, useDraftObject, useRestored } from './park'
import { applyPush, onFace, parseDistance, pickPushFace, pushWords, type PushFace } from './push'
import { OP_LABEL, publishPush, pushActions as pushActionsOf, pushOperation, usePushSnapshot } from './push-session'

/** The tool's state and its ties to the view. Mounted once while the tool is open, with the pane open or shut. */
export function usePushTool(): void {
  const host = useHost()
  const restored = useRestored()
  const [face, setFace] = useDraft<PushFace | null>('face', null, follow((f, now) => f && { ...f, frame: now.frame(f.frame), pick: { ...f.pick, at: now.point(f.pick.at) } }))
  useDraftObject(face?.objectId)
  const [text, setText] = useDraft('text', '')
  const [prism, setPrism] = useState<GeomMesh | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // The handlers below run outside React's render: they read the latest values from here.
  const live = useRef({ face, text, busy, picking: null as Promise<PushFace | null> | null })
  live.current = { ...live.current, face, text, busy }
  const view = cameraBus()?.cad
  const distance = parseDistance(text)
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
      // The face the tool already has (handed back as Model's pick when the tool opens again) keeps its distance.
      const f = live.current.face
      if (f && hit.objectId === f.objectId && (hit.partIndex ?? 0) === f.partIndex && hit.triangle === f.pick.triangle) return
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
    // Back from Slice with its face and distance: nothing to find again.
    if (restored && live.current.face) return
    const now = nowOf(edit.step, edit.entry.transform)
    const at = now.point(edit.step.params.at)
    const part = get().plate.find((p) => p.id === edit.entry.id)?.parts[edit.step.part]
    const tri = part ? findTriangle(part, edit.entry.transform, at, now.dir(edit.step.params.normal)) : -1
    if (!restored) setText(String(edit.step.params.distanceMm))
    if (tri < 0) setNote('The face this step moved is not there before it any more. Pick a face to push instead.')
    else void pick(edit.entry.id, edit.step.part, tri, at)
  }, [edit, pick, restored])

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
          return true
        }
        const r = await applyPush(host.slicer, f, d)
        toast(r.message, r.warn ? 'warn' : 'ok')
        // The mesh changed under the face, so the next push starts from a new pick.
        setFace(null)
        setText('')
        return true
      } catch (e) {
        setNote(errorText(e))
      } finally {
        live.current.busy = false
        setBusy(false)
      }
    },
    [host, edit],
  )

  // The pill says what the tool works on: the picked face shows as Model's face pick while the tool has it, and stays
  // picked when the tool closes. Clearing the pick (the pill's clear, or Esc with no tool) drops the tool's face too.
  const mirrored = useRef<SubPick | null>(null)
  useEffect(() => {
    if (face) {
      const p: SubPick = { kind: 'face', objectId: face.objectId, partIndex: face.partIndex, triangle: face.pick.triangle, point: face.pick.at }
      mirrored.current = p
      set({ subPicks: [p], selection: face.objectId, selectedIds: [face.objectId], towerSelected: false })
    } else if (mirrored.current) {
      const was = mirrored.current
      mirrored.current = null
      set((s) => ({ subPicks: s.subPicks.filter((x) => x !== was) }))
    }
  }, [face])
  const picksGone = useApp((s) => mirrored.current !== null && !s.subPicks.includes(mirrored.current))
  useEffect(() => {
    if (!picksGone || live.current.busy) return
    mirrored.current = null
    setFace(null)
    setText('')
  }, [picksGone])

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

  // The panel, the view's Distance box and the link read the tool here, and change it through these.
  const run = useCallback(async () => {
    const l = live.current
    const d = parseDistance(l.text)
    // a typed distance can follow a named value; a dragged one is a plain number
    bindNext(l.text)
    try {
      return (await apply(d, l.face)) === true
    } finally {
      bindNext(undefined)
    }
  }, [apply])
  const actions = useMemo(() => ({ setText, apply: run }), [run])
  useEffect(() => {
    publishPush(
      {
        face: face ? { objectId: face.objectId, partIndex: face.partIndex, at: face.pick.at, normal: face.frame.normal, thicknessMm: face.thicknessMm } : null,
        text,
        distanceMm: distance,
        busy,
        note,
        editStep: edit ? edit.index + 1 : null,
      },
      actions,
    )
  }, [face, text, distance, busy, note, edit, actions])
  useEffect(() => () => publishPush(null, null), [])
}

/** The tool's panel in the right pane: the same face and distance as the arrow in the view. */
export function PushTool() {
  const s = usePushSnapshot()
  const face = s?.face ?? null
  const text = s?.text ?? ''
  const distance = s?.distanceMm ?? null
  const words = face ? pushWords(distance, face.thicknessMm) : null
  const bad = text.trim() !== '' && distance === null
  const op = pushOperation(distance, face?.thicknessMm ?? null)
  return (
    <Shell title="Push and pull" aside={s?.editStep ? `Editing step ${s.editStep}` : face ? 'A face is picked' : 'No face yet'}>
      {!face ? <PointerHint text="Click a flat face, or drag one in or out. Hold Shift to move in 1 mm steps." /> : <Note status>{words}</Note>}
      <Num id="push-dist" label="Distance along the face normal" unit="mm" value={text} onChange={(t) => s && pushActionsOf()?.setText(t)} />
      {s?.note || bad ? <Message text={s?.note ?? 'Type a number, such as 5 or -3.'} /> : null}
      <ToolFooter
        verb={op === 'pull' || op === null ? OP_LABEL.pull : OP_LABEL.cut}
        verbs={[OP_LABEL.cut, OP_LABEL.pull]}
        onApply={() => pushActionsOf()?.apply()}
        busy={s?.busy ?? false}
        disabled={!face || !distance}
      />
    </Shell>
  )
}
