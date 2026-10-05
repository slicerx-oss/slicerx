'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './button'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Buttons for the footer. The single primary action uses variant "primary". */
  footer?: ReactNode
  /** Put the footer's first child on the left (a destructive or secondary action). */
  splitFooter?: boolean
  size?: 'md' | 'lg'
  /** Skip the close button in the header (for dialogs that must be answered). */
  required?: boolean
  className?: string
  children?: ReactNode
}

/**
 * A modal dialog on the native dialog element, so focus trapping, Escape, and the backdrop come
 * from the browser. The parent owns the open state.
 */
export function Dialog({ open, onClose, title, footer, splitFooter, size = 'md', required, className, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // A close the parent asked for raises the native close event a moment later. It must not count as the person closing a dialog that has since opened again.
  const closedByParent = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) {
      closedByParent.current = true
      el.close()
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      className={className ? `sx-dialog ${className}` : 'sx-dialog'}
      data-size={size === 'md' ? undefined : size}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        if (!required) onClose()
      }}
      onClose={() => {
        if (closedByParent.current) {
          closedByParent.current = false
          return
        }
        onClose()
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself, not on its children.
        if (!required && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sx-dialog-h">
        <h2 id={titleId}>{title}</h2>
        {required ? null : <Button variant="ghost" size="sm" icon="plus" aria-label="Close" className="sx-dialog-close" onClick={onClose} />}
      </div>
      <div className="sx-dialog-body">{children}</div>
      {footer ? (
        <div className="sx-dialog-foot" data-split={splitFooter ? true : undefined}>
          {footer}
        </div>
      ) : null}
    </dialog>
  )
}
