// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made the one face picked in Model, for the pill's crumb and the marks in the tree and timeline, and
// the step menu's Select its faces.
import { useEffect, useState } from 'react'
import { faceSource, facesMadeBy } from '../../cad/history/made-by'
import { point } from '../../cad/history/model'
import { setPickKind } from '../../plate/sub-pick'
import { get, set, toast, useApp } from '../../state/store'

export interface MadeBy {
  objectId: string
  /** The step's index in the object's history, or -1 for a face the object started with. */
  index: number
  /** The steps that used the face, by index. */
  used: number[]
}

export function useMadeBy(): MadeBy | null {
  const picks = useApp((s) => s.subPicks)
  const plate = useApp((s) => s.plate)
  const editing = useApp((s) => s.historyEdit)
  const one = picks.length === 1 && picks[0]!.kind === 'face' ? picks[0]! : null
  const entry = one ? plate.find((p) => p.id === one.objectId) : undefined
  const [made, setMade] = useState<MadeBy | null>(null)
  useEffect(() => {
    setMade(null)
    // a part rolled back to edit a step is not the object's result
    if (!one || !entry || editing?.objectId === entry.id) return
    let live = true
    void faceSource(entry, one.partIndex, one.triangle).then((src) => {
      if (!live || !src) return
      const at = (id: string) => entry.history?.steps.findIndex((s) => s.id === id) ?? -1
      const index = src.made === 'base' ? -1 : at(src.made)
      if (src.made !== 'base' && index < 0) return
      setMade({ objectId: entry.id, index, used: src.used.map(at).filter((i) => i >= 0) })
    })
    return () => {
      live = false
    }
  }, [one?.objectId, one?.partIndex, one?.triangle, entry, editing?.objectId])
  return made
}

/** Picks one point on each face step `stepId` made, as faces, so a tool opened next starts from them. */
export async function selectStepFaces(objectId: string, stepId: string): Promise<void> {
  const entry = get().plate.find((p) => p.id === objectId)
  if (!entry) return
  const faces = await facesMadeBy(entry, stepId)
  if (!faces.length) return toast('This step left no faces of its own on the part.', 'info')
  const centroid = (part: number, t: number): [number, number, number] => {
    const m = entry.parts[part]!
    const c: [number, number, number] = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      const p = point(entry.transform, m.positions, m.indices[t * 3 + k]! * 3)
      for (let a = 0; a < 3; a++) c[a] = c[a]! + p[a]! / 3
    }
    return c
  }
  setPickKind('face', 'only')
  set({ selection: objectId, selectedIds: [objectId], subPicks: faces.map((f) => ({ kind: 'face' as const, objectId, partIndex: f.partIndex, triangle: f.triangle, point: centroid(f.partIndex, f.triangle) })) })
}
