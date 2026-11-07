// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's Project card: edges, a face's outline or a body's outline projected onto the sketch plane as
// curves that follow the model (project-sketch.ts). The person picks what to project and whether its curves are real
// (profile curves, the default) or reference (construction, no profile), and can switch or remove each one later.
import { nextProjectionId, withProjection, withoutProjection, type FaceFrame, type Projection, type ProjectMode, type ProjectSource, type SketchItem, type SketchLoop } from '@slicerx/cad-history'
import type { PickEvent } from '@slicerx/viewport'
import { Button, Seg } from '@slicerx/ui'
import { useState } from 'react'
import { get } from '../state/store'
import { errorText, Message, Note, useProbe } from './panel-kit'
import { bodySource, edgeSource, faceSource, projectNow, projectionName } from './project-sketch'

/** A sketch's projections and their curves, as the editor holds them. */
export interface Projected {
  list: Projection[]
  loops: SketchLoop[]
}

type Kind = 'edges' | 'face' | 'body'

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
const asSketch = (p: Projected, frame: FaceFrame): SketchItem => ({ kind: 'sketch', id: 'draft', name: '', frame, loops: p.loops, projections: p.list })
const fromSketch = (k: SketchItem): Projected => ({ list: k.projections ?? [], loops: k.loops })

function Picker({ onPick, faces }: { onPick: (hit: PickEvent) => void; faces: boolean }) {
  useProbe(onPick, faces)
  return null
}

export function ProjectCard({ frame, value, onChange, locked = false }: { frame: FaceFrame; value: Projected; onChange: (next: Projected) => void; locked?: boolean }) {
  const [picking, setPicking] = useState<Kind | null>(null)
  const [mode, setMode] = useState<ProjectMode>('real')
  const [note, setNote] = useState<string | null>(null)
  // the edges projection a pick adds to, while picking edges
  const [edges, setEdges] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const put = async (source: ProjectSource, id: string) => {
    const loops = await projectNow(source, frame)
    const was = value.list.find((p) => p.id === id)
    onChange(fromSketch(withProjection(asSketch(value, frame), { id, source, mode: was?.mode ?? mode }, loops)))
  }

  const onPick = (hit: PickEvent) => {
    const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
    if (!e || hit.triangle === null || !hit.point || busy || !picking) return
    const part = hit.partIndex ?? 0
    setBusy(true)
    setNote(null)
    const run = async () => {
      if (picking === 'body') {
        await put(bodySource(e), nextProjectionId(asSketch(value, frame)))
        setPicking(null)
      } else if (picking === 'face') {
        await put(faceSource(e, part, hit.triangle!, hit.point!), nextProjectionId(asSketch(value, frame)))
        setPicking(null)
      } else {
        const open = edges ? value.list.find((p) => p.id === edges) : undefined
        const id = open?.id ?? nextProjectionId(asSketch(value, frame))
        await put(await edgeSource(e, part, hit.triangle!, hit.point!, open?.source), id)
        setEdges(id)
      }
    }
    run()
      .catch((err: unknown) => setNote(errorText(err)))
      .finally(() => setBusy(false))
  }

  const start = (k: Kind) => {
    setNote(null)
    setEdges(null)
    setPicking(picking === k ? null : k)
  }
  const switchMode = (id: string, m: ProjectMode) => {
    const p = value.list.find((x) => x.id === id)
    if (p) onChange(fromSketch(withProjection(asSketch(value, frame), { ...p, mode: m }, null)))
  }
  const remove = (id: string) => {
    if (edges === id) setEdges(null)
    onChange(fromSketch(withoutProjection(asSketch(value, frame), id)))
  }

  return (
    <div className="sketch-project" data-testid="sketch-project">
      {locked ? (
        <Note>Projections are added to a finished sketch or a new one; a step opened from the history keeps the ones it has.</Note>
      ) : (
        <>
          <div className="cad-row sketch-project-kinds" role="group" aria-label="Project">
            {(['edges', 'face', 'body'] as const).map((k) => (
              <Button key={k} size="sm" className="tp-pill" data-testid={`sketch-project-${k}`} pressed={picking === k} onClick={() => start(k)}>
                {k === 'edges' ? 'Edges' : k === 'face' ? 'Face' : 'Body'}
              </Button>
            ))}
          </div>
          <div className="tp-row sketch-project-mode">
            <span className="tp-label" data-tip-title="Use as" data-tip-body="Real curves close profiles to extrude or cut. Reference curves are construction: they show and snap, and make no profile.">
              Use as
            </span>
            <Seg label="Use new projections as" size="sm" value={mode} onChange={setMode} options={MODES} />
          </div>
          {picking ? (
            <p className="cad-hint" role="status" data-testid="sketch-project-hint">
              {busy ? 'Projecting...' : HINTS[picking]}
            </p>
          ) : null}
          {picking === 'edges' && edges ? (
            <Button size="sm" className="tp-pill" data-testid="sketch-project-done" onClick={() => (setPicking(null), setEdges(null))}>
              Done
            </Button>
          ) : null}
          {picking ? <Picker onPick={onPick} faces={picking !== 'edges'} /> : null}
        </>
      )}
      {value.list.map((p) => (
        <div key={p.id} className="sketch-projection" data-testid={`sketch-projection-${p.id}`}>
          <div className="cad-row">
            <span className="sketch-projection-name">{projectionName(p.source)}</span>
            <Seg label={`Use ${projectionName(p.source)} as`} size="sm" value={p.mode} onChange={(m) => switchMode(p.id, m)} options={MODES} />
            <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove ${projectionName(p.source)}`} data-testid={`sketch-projection-${p.id}-remove`} onClick={() => remove(p.id)} />
          </div>
          {p.lost ? <Message text={p.lost} testId={`sketch-projection-${p.id}-lost`} /> : null}
        </div>
      ))}
      {note ? <Message text={note} /> : null}
    </div>
  )
}
