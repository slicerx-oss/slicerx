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
  /**
   * A dialog that must be answered: no close button, Escape and the backdrop do nothing, and no key reaches anything
   * behind it (the app's shortcuts included). The browser cannot close it on its own either.
   */
  required?: boolean
  className?: string
  children?: ReactNode
}

// The required dialogs on screen. While one is open it holds the keyboard. The listener is the first on the window in
// the capture phase (added when this module loads, before any shortcut handler), so no handler sees a key: Tab, Enter
// and Space still move between and press the dialog's own buttons, since their default actions stay.
const holding = new Set<HTMLDialogElement>()
if (typeof window !== 'undefined') {
  const hold = (e: KeyboardEvent) => {
    if (holding.size === 0) return
    e.stopImmediatePropagation()
    const inside = [...holding].some((d) => e.target instanceof Node && d.contains(e.target))
    // Escape would ask the browser to close the dialog, and Chromium closes it anyway on a second press.
    if (e.key === 'Escape' || !inside) e.preventDefault()
  }
  window.addEventListener('keydown', hold, true)
  window.addEventListener('keyup', hold, true)
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
    if (!el || !required || !open) return
    holding.add(el)
    return () => void holding.delete(el)
  }, [required, open])
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
        // Closed by the browser while it must be answered: it comes straight back.
        if (required && open) return void ref.current?.showModal()
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
