// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shell tool: click the flat faces to leave open (a click on an open face closes it again), type the wall, and
// the body is hollowed with those faces open, as a step of the object's history. Flat bodies get an exact wall;
// a body with curved faces gets the voxel wall, and the toast says so (sx-geom shell.rs). The wall takes named
// values (values.ts).
import type { PickEvent } from '@slicerx/viewport'
import { Icon } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { pickFace, type OpenFace } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { get, set, toast } from '../state/store'
import { loopsOf } from './cad-ops'
import { applyShell } from './holes'
import { keyOfTriangle } from './history/model'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { close, errorText, num, Num, pickWords, Shell, useProbe, ToolFooter } from './panel-kit'
import { follow, useDraft, useDraftObject } from './park'

interface Picked {
  objectId: string
  partIndex: number
  faces: (OpenFace & { lines: [number, number, number][][] })[]
}

const same = (a: OpenFace, b: OpenFace) => Math.abs(a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2] - 1) < 1e-6 && Math.abs((a.at[0] - b.at[0]) * a.normal[0] + (a.at[1] - b.at[1]) * a.normal[1] + (a.at[2] - b.at[2]) * a.normal[2]) < 1e-3

export function ShellTool() {
  const host = useHost()
  const edit = (() => {
    const ed = editing()
    const p = ed?.step.params
    return ed && p?.op === 'shell' ? { index: ed.index, objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part), params: p, step: ed.step, entry: ed.entry } : null
  })()
  const [picked, setPicked] = useDraft<Picked | null>('picked', () => {
    if (!edit) return null
    const now = nowOf(edit.step, edit.entry.transform)
    return { objectId: edit.objectId, partIndex: edit.partIndex, faces: edit.params.open.map((o) => ({ at: now.point(o.at), normal: now.dir(o.normal), ...(o.key ? { key: o.key } : {}), lines: [] })) }
  }, follow((p, now) => p && { ...p, faces: p.faces.map((f) => ({ ...f, at: now.point(f.at), normal: now.dir(f.normal), lines: f.lines.map((l) => l.map(now.point)) })) }))
  useDraftObject(picked?.objectId)
  const [wall, setWall] = useDraft('wall', edit ? String(edit.params.wallMm) : '2')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const loops = (picked?.faces ?? []).flatMap((f) => f.lines.map((points) => ({ points })))
    cameraBus()?.guides?.({ loops })
    return () => cameraBus()?.guides?.({})
  }, [picked])

  const onPick = useCallback((hit: PickEvent) => {
    if (!hit.objectId || hit.triangle === null || !hit.point) return
    const objectId = hit.objectId
    const partIndex = hit.partIndex ?? 0
    const e = get().plate.find((p) => p.id === objectId)
    const part = e?.parts[partIndex]
    if (!e || !part) return
    setNote(null)
    pickFace({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }).then(
      (f) => {
        const key = keyOfTriangle(part, hit.triangle!)
        const face = { at: hit.point!, normal: f.frame.normal, ...(key ? { key } : {}), lines: loopsOf(f.frame, f.outline) }
        setPicked((was) => {
          // Another object starts over; the same face again closes it.
          const faces = was && was.objectId === objectId && was.partIndex === partIndex ? was.faces : []
          const kept = faces.filter((x) => !same(x, face))
          return { objectId, partIndex, faces: kept.length < faces.length ? kept : [...faces, face] }
        })
      },
      (err: unknown) => {
        const words = pickWords(err)
        if (words) setNote(words.replace('Pick a flat face', 'Only flat faces can be left open'))
      },
    )
  }, [])
  useProbe(onPick, false)

  const wallMm = num(wall)
  const target = picked ?? (() => {
    // With nothing clicked yet, the shell closes the selected object all round.
    const id = get().selection
    return id && get().plate.some((p) => p.id === id) ? { objectId: id, partIndex: 0, faces: [] } : null
  })()
  const ready = target !== null && Number.isFinite(wallMm) && wallMm > 0

  const apply = async () => {
    if (!target || !ready || busy) return
    setBusy(true)
    setNote(null)
    try {
      const params = { op: 'shell' as const, open: target.faces.map(({ at, normal, key }) => ({ at, normal, ...(key ? { key } : {}) })), wallMm }
      bindNext(wall)
      if (edit) {
        await saveEdit(host.slicer, params)
        toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applyShell(host.slicer, target.objectId, target.partIndex, params)
      toast(r.message, r.warn ? 'warn' : 'ok')
      setPicked(null)
      return true
    } catch (err) {
      setNote(errorText(err))
    } finally {
      bindNext(undefined)
      setBusy(false)
    }
  }

  const n = target?.faces.length ?? 0
  return (
    <Shell title="Shell" aside={edit ? `Editing step ${edit.index + 1}` : n ? `${n} open face${n === 1 ? '' : 's'}` : target ? 'Closed all round' : 'Nothing picked yet'}>
      <p className="cad-hint"><Icon name="mouse-left" size={15} /> Click the flat faces to leave open; click one again to close it.</p>
      <div className="cad-pair">
        <Num id="shell-wall" label="Wall" unit="mm" value={wall} onChange={setWall} onEnter={() => void apply()} />
      </div>
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <ToolFooter verb="Make shell" onApply={apply} busy={busy} disabled={!ready} />
    </Shell>
  )
}
