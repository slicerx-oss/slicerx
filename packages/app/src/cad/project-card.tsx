// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's Project card: edges, a face's outline or a body's outline projected onto the sketch plane as
// curves that follow the model (project-sketch.ts). The person picks what to project and whether its curves are real
// (profile curves, the default) or reference (construction, no profile), and can switch or remove each one later.
import { nextProjectionId, withProjection, withoutProjection, type FaceFrame, type Projection, type ProjectMode, type ProjectSource, type SketchItem, type SketchLoop } from '@slicerx/cad-history'
import type { PickEvent } from '@slicerx/viewport'
import { Button, Seg } from '@slicerx/ui'
import { useRef, useState } from 'react'
import { get } from '../state/store'
import { errorText, Message, Note, useProbe } from './panel-kit'
import { addsTo, bodySource, edgeSource, faceSource, projectNow, projectionName } from './project-sketch'

/** A sketch's projections and their curves, as the editor holds them, and how many ids it has handed out. */
export interface Projected {
  list: Projection[]
  loops: SketchLoop[]
  next: number
}

type Kind = 'edges' | 'face' | 'body'

const KINDS: { value: Kind; label: string; testId: string }[] = [
  { value: 'edges', label: 'Edges', testId: 'sketch-project-edges' },
  { value: 'face', label: 'Face', testId: 'sketch-project-face' },
  { value: 'body', label: 'Body', testId: 'sketch-project-body' },
]

const MODES: { value: ProjectMode; label: string }[] = [
  { value: 'real', label: 'Real' },
  { value: 'reference', label: 'Reference' },
]

const HINTS: Record<Kind, string> = {
  edges: 'Click edges on the model; they join one projection. Done ends it.',
  face: 'Click a face on the model to project its outline, holes kept.',
  body: 'Click a body to project its outline as seen from the sketch.',
}

/** The projections as a sketch item, so the cad-history helpers can change them. */
const asSketch = (p: Projected, frame: FaceFrame): SketchItem => ({ kind: 'sketch', id: 'draft', name: '', frame, loops: p.loops, projections: p.list, ...(p.next ? { nextProjection: p.next } : {}) })
const fromSketch = (k: SketchItem): Projected => ({ list: k.projections ?? [], loops: k.loops, next: k.nextProjection ?? 0 })

function Picker({ onPick, faces }: { onPick: (hit: PickEvent) => void; faces: boolean }) {
  useProbe(onPick, faces)
  return null
}

/**
 * `sketch` is the finished sketch being changed: a source is read where that sketch is in the timeline, as the MCP
 * tool and replay read it. A new sketch reads the model as it stands. `locked` (a step opened from the history) shows
 * the projections and changes none.
 */
export function ProjectCard({ frame, value, onChange, locked = false, sketch }: { frame: FaceFrame; value: Projected; onChange: (next: Projected) => void; locked?: boolean; sketch?: string }) {
  const [picking, setPicking] = useState<Kind | null>(null)
  const [mode, setMode] = useState<ProjectMode>('real')
  const [note, setNote] = useState<string | null>(null)
  // the edges projection a pick adds to, while picking edges
  const [edges, setEdges] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the projections as they are now, for a pick that answers after other changes; and the picks still to run, in order
  const latest = useRef(value)
  latest.current = value
  const open = useRef<string | null>(null)
  // counts each new edges projection the person starts or ends, so a pick that answers after Done, a fresh start or
  // the open projection's removal does not reopen the one it was made for
  const session = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const change = (next: Projected) => {
    latest.current = next
    onChange(next)
  }

  /** Puts `source` in as projection `id`; one that adds to an open projection removed meanwhile is dropped. Says whether it went in. */
  const put = async (source: ProjectSource, id: string, adds: boolean): Promise<boolean> => {
    const loops = await projectNow(source, frame, sketch)
    const now = latest.current
    const was = now.list.find((p) => p.id === id)
    if (adds && !was) return false
    change(fromSketch(withProjection(asSketch(now, frame), { id, source, mode: was?.mode ?? mode }, loops)))
    return true
  }

  const onPick = (hit: PickEvent) => {
    const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
    const kind = picking
    if (!e || hit.triangle === null || !hit.point || !kind) return
    const part = hit.partIndex ?? 0
    setBusy(true)
    setNote(null)
    const at = session.current
    const run = async () => {
      const fresh = () => nextProjectionId(asSketch(latest.current, frame))
      if (kind === 'body') {
        await put(bodySource(e), fresh(), false)
        setPicking(null)
      } else if (kind === 'face') {
        await put(faceSource(e, part, hit.triangle!, hit.point!), fresh(), false)
        setPicking(null)
      } else {
        const from = open.current ? latest.current.list.find((p) => p.id === open.current) : undefined
        const next = await edgeSource(e, part, hit.triangle!, hit.point!, from?.source)
        // an edge of another body or part starts a projection of its own
        const adds = !!from && addsTo(from.source, next)
        const id = adds ? from.id : fresh()
        if ((await put(next, id, adds)) && session.current === at) {
          open.current = id
          setEdges(id)
        }
      }
    }
    // picks run one after another, each on what the one before left
    queue.current = queue.current
      .then(run)
      .catch((err: unknown) => setNote(errorText(err)))
      .finally(() => setBusy(false))
  }

  /** Ends the open edges projection: the next edge starts a new one. */
  const close = () => {
    session.current++
    open.current = null
    setEdges(null)
  }
  const start = (k: Kind) => {
    setNote(null)
    close()
    setPicking(picking === k ? null : k)
  }
  const switchMode = (id: string, m: ProjectMode) => {
    const p = latest.current.list.find((x) => x.id === id)
    if (p) change(fromSketch(withProjection(asSketch(latest.current, frame), { ...p, mode: m }, null)))
  }
  const remove = (id: string) => {
    if (open.current === id || edges === id) close()
    change(fromSketch(withoutProjection(asSketch(latest.current, frame), id)))
  }

  return (
    <div className="sketch-project" data-testid="sketch-project">
      {locked ? (
        <Note>Projections are added to a finished sketch or a new one; a step opened from the history keeps the ones it has.</Note>
      ) : (
        <>
          <Seg label="Project" size="sm" full className="sketch-project-kinds" value={picking ?? ('' as Kind)} onChange={start} options={KINDS} />
          {picking ? (
            <p className="cad-hint" role="status" data-testid="sketch-project-hint">
              {busy ? 'Projecting…' : HINTS[picking]}
            </p>
          ) : null}
          {picking === 'edges' && edges ? (
            <Button size="sm" className="tp-pill" data-testid="sketch-project-done" onClick={() => (setPicking(null), close())}>
              Done
            </Button>
          ) : null}
          {picking ? <Picker onPick={onPick} faces={picking !== 'edges'} /> : null}
        </>
      )}
      {/* "Use as" and each projection share three columns, so their choices line up */}
      <div className="sketch-project-list">
        {locked ? null : (
          <div className="sketch-projection sketch-project-mode">
            <span className="tp-label" data-tip-title="Use as" data-tip-body="Real curves close profiles to extrude or cut. Reference curves are construction: they show and snap, and make no profile.">
              Use as
            </span>
            <Seg label="Use new projections as" size="sm" value={mode} onChange={setMode} options={MODES} />
            <span />
          </div>
        )}
        {value.list.map((p) => {
          const name = projectionName(p.source)
          return (
            <div key={p.id} className="sketch-projection" data-testid={`sketch-projection-${p.id}`}>
              <span className="sketch-projection-name" data-tip-title={name}>
                {name}
              </span>
              {locked ? (
                <span className="sketch-projection-mode">{p.mode === 'real' ? 'Real' : 'Reference'}</span>
              ) : (
                <Seg label={`Use ${name} as`} size="sm" value={p.mode} onChange={(m) => switchMode(p.id, m)} options={MODES} />
              )}
              {locked ? <span /> : <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove ${name}`} data-testid={`sketch-projection-${p.id}-remove`} onClick={() => remove(p.id)} />}
              {p.lost ? (
                <div className="sketch-projection-note">
                  <Message text={p.lost} testId={`sketch-projection-${p.id}-lost`} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {note ? <Message text={note} /> : null}
    </div>
  )
}
