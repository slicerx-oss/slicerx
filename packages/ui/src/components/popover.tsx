'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from '../hooks/use-dismiss'
import { usePlacement } from '../hooks/use-placement'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  /** Accessible name of the dialog. */
  label: string
  align?: 'start' | 'end'
  className?: string
  children?: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * A lifted surface anchored to its trigger, for content richer than a menu (a list with status, a form row). Place it
 * inside a MenuAnchor with its trigger. Escape or an outside click calls onClose; focus moves into it on open and back
 * to the trigger on close.
 */
export function Popover({ open, onClose, label, align = 'start', className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  useDismiss(ref, open, onClose)
  const { place, style } = usePlacement(ref, open, align)
  const lifted = Boolean(place.fixed)
  useEffect(() => {
    if (!open) return
    returnTo.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null
    // without scrolling: the first render sits in the pane before it is placed, and a focus there scrolled the pane
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
  }, [open, lifted])
  useEffect(() => {
    if (open) return
    const back = returnTo.current
    returnTo.current = null
    if (back?.isConnected) back.focus({ preventScroll: true })
  }, [open])
  if (!open) return null
  const box = (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={className ? `sx-popover sx-overlay ${className}` : 'sx-popover sx-overlay'}
      data-align={align === 'start' ? undefined : align}
      data-side={place.up ? 'top' : undefined}
      data-lifted={lifted ? true : undefined}
      style={style}
    >
      {children}
    </div>
  )
  return lifted && typeof document !== 'undefined' ? createPortal(box, document.body) : box
}
