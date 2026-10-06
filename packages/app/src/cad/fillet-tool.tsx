// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fillet and chamfer (docs/cad-fillet.md): round or bevel the straight edges where two flat faces
// meet. Hover lights the edge under the cursor, a click picks it, Shift and a click add more, and
// "Whole loop" takes every edge around the face. A typed radius or distance shows what would go (red)
// and what would be added (green) before the op runs once on Apply, as a step of the object's history.
//
// Speed: the view reports the cursor at most once a frame and only while this tool is open. The
// engine is asked about a face once (edge.pick gives the ring of edges around it); moving along that
// face picks the nearest edge of the ring here, with no engine call and no React render.
import type { PickEvent, ProbeHover } from '@slicerx/viewport'
import { Button, Icon, Seg } from '@slicerx/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Vec3 } from '../geom/cad'
import { edgePreview, pickEdge, type EdgePick, type EdgeRef } from './edge-api'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { get, set, toast, type PlateEntry } from '../state/store'
import { addEdge, applyEdges, edgeDistance, edgeLines, edgeParams, sameEdge, type Kind } from './edges'
import { followed } from './history/model'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { close, errorText, num, Num, Shell, useProbe } from './panel-kit'

interface Picked {
  objectId: string
  partIndex: number
  edges: EdgeRef[]
  /** The last edge.pick, for its limits and its loop. */
  last: EdgePick | null
}

function editState(): { index: number; picked: Picked; kind: Kind; size: string; size2: string } | null {
  const ed = editing()
  const p = ed?.step.params
  if (!ed || !p || (p.op !== 'edge.fillet' && p.op !== 'edge.chamfer')) return null
  const now = nowOf(ed.step, ed.entry.transform)
  // Where the edges are now, after the faces they sit on moved.
  const q = followed(ed.step, ed.entry.history?.steps ?? []).params
  const edges = (q.op === 'edge.fillet' || q.op === 'edge.chamfer' ? q.edges : p.edges).map((e) => ({ a: now.point(e.a), b: now.point(e.b), face: now.dir(e.face), ...(e.center ? { center: now.point(e.center) } : {}), ...(e.keys ? { keys: e.keys } : {}) }))
  return {
    index: ed.index,
    picked: { objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part), edges, last: null },
    kind: p.op === 'edge.fillet' ? 'fillet' : 'chamfer',
    size: String(p.op === 'edge.fillet' ? p.radiusMm : p.distanceMm),
    size2: p.op === 'edge.chamfer' && p.distance2Mm !== undefined ? String(p.distance2Mm) : '',
  }
}

export function FilletTool() {
  const host = useHost()
  const view = cameraBus()?.cad
  const [edit] = useState(editState)
  const [kind, setKind] = useState<Kind>(edit?.kind ?? 'fillet')
  const [picked, setPicked] = useState<Picked | null>(edit?.picked ?? null)
  const [size, setSize] = useState(edit?.size ?? '1')
  const [size2, setSize2] = useState(edit?.size2 ?? '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewOk, setPreviewOk] = useState(false)
  // The hover path reads and writes here, outside React.
  const live = useRef({ picked, hover: null as EdgeRef | null, ring: null as { objectId: string; partIndex: number; point: Vec3; normal: Vec3; edges: EdgeRef[] } | null, asking: null as AbortController | null })
  live.current.picked = picked

  const entryOf = (id: string): PlateEntry | undefined => get().plate.find((p) => p.id === id)

  // Guides: picked edges as lines (a round edge as its circle), the hovered one with its end points.
  const draw = useCallback(() => {
    const l = live.current
    const lines = (l.picked?.edges ?? []).flatMap(edgeLines)
    const h = l.hover
    if (h && !l.picked?.edges.some((e) => sameEdge(e, h))) lines.push(...edgeLines(h))
    cameraBus()?.guides?.({ lines, points: h ? [h.a, h.b] : [] })
  }, [])
  useEffect(draw, [picked, draw])

  const ask = useCallback(async (objectId: string, partIndex: number, triangle: number, at: Vec3, signal?: AbortSignal): Promise<EdgePick> => {
    const e = entryOf(objectId)
    const part = e?.parts[partIndex]
    if (!e || !part) throw new Error('That object is gone.')
    return pickEdge({ mesh: toGeom(part), transform: e.transform }, { triangle, at }, signal)
  }, [])

  // Hover: once per face from the engine, then the nearest edge of that face's ring, here.
  useEffect(() => {
    if (!view) return
    view.setProbeHover(true)
    const off = view.on('probehover', (h: ProbeHover | null) => {
      const l = live.current
      if (!h) {
        if (l.hover) {
          l.hover = null
          draw()
        }
        return
      }
      const r = l.ring
      if (r && r.objectId === h.objectId && r.partIndex === h.partIndex && Math.abs((h.point[0] - r.point[0]) * r.normal[0] + (h.point[1] - r.point[1]) * r.normal[1] + (h.point[2] - r.point[2]) * r.normal[2]) < 0.01) {
        let best: EdgeRef | null = null
        let bestD = Infinity
        for (const e of r.edges) {
          const d = edgeDistance(h.point, e)
          if (d < bestD) {
            bestD = d
            best = e
          }
        }
        if (best !== l.hover) {
          l.hover = best
          draw()
        }
        return
      }
      if (l.asking) return
      const ac = new AbortController()
      l.asking = ac
      ask(h.objectId, h.partIndex, h.triangle, h.point, ac.signal).then(
        (p) => {
          l.ring = { objectId: h.objectId, partIndex: h.partIndex, point: h.point, normal: p.faces[0]?.normal ?? [0, 0, 1], edges: p.loop.length ? p.loop.map((x) => x.edge) : [p.edge] }
          l.hover = p.edge
          draw()
        },
        () => {
          // A curved face or a pick far from any edge: nothing to light.
          l.ring = null
          if (l.hover) {
            l.hover = null
            draw()
          }
        },
      ).finally(() => {
        if (l.asking === ac) l.asking = null
      })
    })
    return () => {
      off()
      live.current.asking?.abort()
      view.setProbeHover(false)
      view.setEdgePreview(null)
    }
  }, [view, ask, draw])

  const onPick = useCallback(
    (hit: PickEvent) => {
      if (!hit.objectId || hit.triangle === null || !hit.point) return
      const objectId = hit.objectId
      const partIndex = hit.partIndex ?? 0
      setNote(null)
      void ask(objectId, partIndex, hit.triangle, hit.point).then(
        (p) => {
          if (!p.supported) return setNote(p.reason ?? 'This edge cannot be rounded or beveled.')
          const cur = live.current.picked
          const same = cur && cur.objectId === objectId && cur.partIndex === partIndex
          setPicked({ objectId, partIndex, edges: addEdge(same ? cur.edges : [], p.edge, Boolean(hit.shift) && Boolean(same)), last: p })
        },
        (e: unknown) => setNote(errorText(e)),
      )
    },
    [ask],
  )
  useProbe(onPick, false)

  const wholeLoop = () => {
    const p = picked?.last
    if (!picked || !p) return
    const more = p.loop.filter((x) => x.supported).map((x) => x.edge)
    const skipped = p.loop.length - more.length
    setPicked({ ...picked, edges: more.reduce((acc, e) => (acc.some((x) => sameEdge(x, e)) ? acc : [...acc, e]), picked.edges) })
    if (skipped) setNote(`${skipped} ${skipped === 1 ? 'edge' : 'edges'} of the loop cannot be rounded and stay as they are.`)
  }

  const s1 = num(size)
  const s2 = size2.trim() === '' ? null : num(size2)
  const sizeOk = Number.isFinite(s1) && s1 > 0 && (s2 === null || (Number.isFinite(s2) && s2 > 0))
  const limit = picked?.last ? (kind === 'fillet' ? picked.last.maxRadiusMm : Math.min(...picked.last.maxDistanceMm)) : null

  // The live preview, a moment after the last change. A newer change cancels the one running.
  useEffect(() => {
    setPreviewOk(false)
    if (!view || !picked || !picked.edges.length || !sizeOk) return void view?.setEdgePreview(null)
    const e = entryOf(picked.objectId)
    const part = e?.parts[picked.partIndex]
    if (!e || !part) return
    const ac = new AbortController()
    const t = setTimeout(() => {
      edgePreview({ mesh: { mesh: toGeom(part), transform: e.transform }, edges: picked.edges, profile: kind === 'fillet' ? { kind, radiusMm: s1 } : { kind, distanceMm: s1, ...(s2 !== null ? { distance2Mm: s2 } : {}) } }, ac.signal).then(
        (r) => {
          if (ac.signal.aborted) return
          view.setEdgePreview(r)
          setPreviewOk(true)
          setNote(null)
        },
        (err: unknown) => {
          if (ac.signal.aborted) return
          view.setEdgePreview(null)
          setNote(errorText(err))
        },
      )
    }, 120)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [view, picked, kind, s1, s2, sizeOk])

  const apply = async () => {
    if (!picked || !picked.edges.length || !sizeOk || busy) return
    setBusy(true)
    setNote(null)
    try {
      const params = edgeParams(kind, picked.edges, s1, kind === 'chamfer' ? s2 : null)
      bindNext(size)
      if (edit) {
        await saveEdit(host.slicer, params)
        toast(`Changed step ${edit.index + 1} and ran the steps after it.`, 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applyEdges(host.slicer, picked.objectId, picked.partIndex, params)
      toast(r.message, r.warn ? 'warn' : 'ok')
      // The edges moved: the next ones are picked on the new mesh.
      setPicked(null)
      live.current.ring = null
    } catch (err) {
      setNote(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const n = picked?.edges.length ?? 0
  return (
    <Shell title="Fillet and chamfer" aside={edit ? `Editing step ${edit.index + 1}` : n ? `${n} ${n === 1 ? 'edge' : 'edges'}` : 'No edge yet'}>
      <Seg label="Edge shape" size="sm" full value={kind} onChange={setKind} options={[{ value: 'fillet', label: 'Fillet' }, { value: 'chamfer', label: 'Chamfer' }]} />
      <p className="cad-hint"><Icon name="mouse-left" size={15} /> {n ? 'Shift and click to add or remove an edge.' : 'Click an edge between two flat faces. Shift and click adds more.'}</p>
      <div className="cad-pair">
        <Num id="edge-size" label={kind === 'fillet' ? 'Radius' : 'Distance'} unit="mm" value={size} onChange={setSize} onEnter={() => void apply()} />
        {kind === 'chamfer' ? <Num id="edge-size2" label="Other face, if different" unit="mm" value={size2} onChange={setSize2} onEnter={() => void apply()} /> : null}
      </div>
      {limit !== null && Number.isFinite(limit) ? <p className="cad-hint"><Icon name="info" size={15} /> At most {limit.toFixed(2)} mm on the last picked edge.</p> : null}
      <div className="cad-row">
        <span className="sx-small sx-muted">{picked?.last ? `${picked.last.loop.length} edges around this face` : 'Pick an edge to offer its loop'}</span>
        <Button size="sm" variant="ghost" data-tip="cad.edgeLoop" disabled={!picked?.last || busy} onClick={wholeLoop}>Whole loop</Button>
      </div>
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={() => (n ? setPicked(null) : close())} disabled={busy}>{n ? 'Clear' : 'Done'}</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || !n || !sizeOk || (!previewOk && note !== null)}>
          {busy ? 'Working' : kind === 'fillet' ? 'Round' : 'Bevel'}
        </Button>
      </div>
    </Shell>
  )
}
