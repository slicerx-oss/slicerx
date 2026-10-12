// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The view follows mimir's steps: the caption names the step running now ("Sketch, XY", "Extrude, Z"), and a step that
// changes how the part is best seen turns the camera when it is done (top to isometric after an extrude). Off when
// the run ends: the caption goes back to naming the view.
import type { Transcript } from '@slicerx/pilot/ui'
import { createStore, useStore } from 'zustand'
import { setCamera } from '../../state/store'
import { wordsFor } from './step-words'

export const viewStep = createStore<{ caption: string | null }>()(() => ({ caption: null }))

export function useStepCaption(): string | null {
  return useStore(viewStep, (s) => s.caption)
}

/** The caption for the step running in the last turn, or null. */
export function runningCaption(t: Transcript): string | null {
  const turn = t.turns.at(-1)
  if (!turn || t.status !== 'running') return null
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i]!
    if (b.kind !== 'tools') continue
    const row = b.rows.findLast((r) => r.state === 'running')
    if (row) return wordsFor(row.tool)?.caption ?? null
  }
  return null
}

/** Tool calls finished since the last look, by call id, so each one turns the camera once. */
const turned = new Set<string>()

/** Follows the transcript: sets the caption, and turns the camera after a step that asks for it. */
export function followSteps(t: Transcript): void {
  const caption = runningCaption(t)
  if (viewStep.getState().caption !== caption) viewStep.setState({ caption })
  const turn = t.turns.at(-1)
  if (!turn) return
  for (const b of turn.blocks) {
    if (b.kind !== 'tools') continue
    for (const r of b.rows) {
      if (r.state !== 'ok' || turned.has(r.callId)) continue
      turned.add(r.callId)
      const camera = wordsFor(r.tool)?.camera
      if (camera) setCamera(camera)
    }
  }
}
