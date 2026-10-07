// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Design tree: each object on the plate with its history steps under it (a sketch as a sub-row under its
// extrude), then its parts and volumes. The selected object, and one whose step is open, start expanded.
// Steps use the same rows and operations as the history list in Slice (cad/history), so nothing new is stored.
import { Icon } from '@slicerx/ui'
import { useState } from 'react'
import { HistorySteps } from '../../cad/history/history-panel'
import { selectObject } from '../../plate/edit'
import { useApp, type PlateEntry } from '../../state/store'

export function HistoryTree() {
  const plate = useApp((s) => s.plate)
  // A step being edited rolls its object back; when the object did not exist yet it leaves the plate, so the tree keeps it.
  const editing = useApp((s) => s.historyEdit)
  const selection = useApp((s) => s.selection)
  const selected = useApp((s) => s.selectedIds)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const rows: PlateEntry[] = editing && !plate.some((p) => p.id === editing.objectId) ? [...plate, editing.original] : plate
  if (!rows.length) return <p className="dtree-empty sx-small sx-muted">Add a model or a shape to start.</p>
  return (
    <ul className="dtree" aria-label="Objects and their steps">
      {rows.map((p) => {
        const steps = (editing?.objectId === p.id ? editing.original : p).history?.steps.length ?? 0
        const isOpen = open[p.id] ?? (p.id === selection || p.id === editing?.objectId)
        const isSel = p.id === selection || selected.includes(p.id)
        return (
          <li key={p.id} className="dtree-obj" data-open={isOpen || undefined}>
            <div className="dtree-row" data-selected={isSel || undefined}>
              <button type="button" className="dtree-chev" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.name}`} onClick={() => setOpen((o) => ({ ...o, [p.id]: !isOpen }))}>
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>
              <button
                type="button"
                className="dtree-name"
                aria-pressed={isSel}
                onClick={(e) => {
                  const additive = e.metaKey || e.ctrlKey || e.shiftKey
                  selectObject(p.id, additive)
                  if (!additive) setOpen((o) => ({ ...o, [p.id]: true }))
                }}
              >
                <Icon name="cube" size={15} />
                <span className="min0">{p.name}</span>
              </button>
              <span className="dtree-count sx-mono">{steps ? steps : 'mesh'}</span>
            </div>
            {isOpen ? (
              <div className="dtree-body">
                {steps ? <HistorySteps objectId={p.id} tree /> : null}
                <ul className="dtree-parts" aria-label={`Parts of ${p.name}`}>
                  {p.handle.parts.map((part, i) => (
                    <li key={`${part.name}-${i}`}>
                      <Icon name="cube" size={13} />
                      <span className="min0">{part.name}</span>
                    </li>
                  ))}
                  {(p.volumes ?? []).map((v) => (
                    <li key={v.id}>
                      <Icon name="hollow" size={13} />
                      <span className="min0">{v.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
