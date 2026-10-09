// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check's notes under an object in the list: one line per kind of problem, with the pairs behind
// Show which and a fix beside it where the app can make one (gaps in the model itself are the designer's).
import { Icon, LinkButton, tipAttrs } from '@slicerx/ui'
import { useState } from 'react'
import { resolveConfig } from '../../adapters/settings'
import { fitNotes, type FitNote } from '../../plate/fit-notes'
import { allTouches, objectFit, useFits } from '../../plate/fit-state'
import { arrangePlate } from '../../plate/edit'
import { markStale, set, useApp } from '../../state/store'

function fixFor(id: string, n: FitNote): { label: string; tip: string; run: () => void } | null {
  if (n.kind === 'touch')
    return {
      label: 'Move it clear',
      tip: 'Moves this object to the nearest free spot on the plate.',
      run: () => {
        set({ selection: id, selectedIds: [id] })
        void arrangePlate('selection')
      },
    }
  if (n.kind === 'vertical' && n.layerMm)
    return {
      label: `Use ${n.layerMm.toFixed(2)} mm layers`,
      tip: 'Sets the layer height so every gap stays open.',
      run: () => {
        set((s) => ({ overrides: { ...s.overrides, layer_height: n.layerMm! }, goal: 'custom' as const }))
        markStale()
      },
    }
  return null
}

function Note({ id, note }: { id: string; note: FitNote }) {
  const [open, setOpen] = useState(false)
  const fix = fixFor(id, note)
  return (
    <li className="obj-note" data-kind={note.kind}>
      <Icon name={note.kind === 'touch' || note.kind === 'apart' ? 'alert' : 'tolerance'} size={12} />
      <span className="obj-note-text">{note.text}.</span>
      <span className="obj-note-acts">
        <LinkButton expanded={open} onClick={() => setOpen(!open)}>
          Show which
        </LinkButton>
        {fix ? (
          <LinkButton onClick={fix.run} {...tipAttrs({ title: fix.label, body: fix.tip })}>
            {fix.label}
          </LinkButton>
        ) : null}
      </span>
      {open ? (
        <ul className="obj-note-which">
          {note.which.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function FitNotes({ id }: { id: string }) {
  useFits()
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const names = new Map(plate.map((p) => [p.id, p.name]))
  const splits = new Map(plate.map((p) => [p.id, p.splitOf]))
  const fit = objectFit(id)
  const layerHeightMm = fit?.gaps.some((g) => g.kind === 'vertical') ? Number(resolveConfig(easy, overrides)['layer_height']) || 0.2 : 0.2
  const notes = fitNotes(id, fit, allTouches(), (o) => names.get(o) ?? 'another object', layerHeightMm, (o) => splits.get(o))
  if (!notes.length) return null
  return (
    <ul className="obj-notes" aria-label="Fit check">
      {notes.map((n) => (
        <Note key={n.kind} id={id} note={n} />
      ))}
    </ul>
  )
}
