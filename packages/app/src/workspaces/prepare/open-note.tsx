// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the last open or import said (the printer it opened on, the settings it applied, "Added cube.stl"), as one line
// under the printer card with a close button, and its action (Change printer, Keep separate) under the text. It never
// covers the view; errors and warnings stay toasts. Details shows the whole text when the line cuts it short.
import { Button, Icon } from '@slicerx/ui'
import { useLayoutEffect, useRef, useState } from 'react'
import { set, useApp } from '../../state/store'

export function OpenNote() {
  const note = useApp((s) => s.openNote)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const text = useRef<HTMLSpanElement>(null)
  // A new note starts as one line again.
  useLayoutEffect(() => setOpen(false), [note?.id])
  useLayoutEffect(() => {
    const el = text.current
    if (!el || open) return
    setCut(el.scrollWidth > el.clientWidth + 1)
  })
  if (!note) return null
  return (
    <div className="open-note" role="status" data-testid="open-note" data-open={open || undefined}>
      <Icon name="info" size={16} />
      <span ref={text} className="open-note-text" data-testid="open-note-text">
        {note.text}
      </span>
      <Button variant="ghost" size="sm" icon="close" data-testid="open-note-dismiss" aria-label="Dismiss" onClick={() => set({ openNote: null })} />
      {cut || open || note.action ? (
        <div className="open-note-acts">
          {cut || open ? (
            <Button variant="ghost" size="sm" data-testid="open-note-details" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Less' : 'Details'}
            </Button>
          ) : null}
          {note.action ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="open-note-action"
              onClick={() => {
                note.action!.run()
                set({ openNote: null })
              }}
            >
              {note.action.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
