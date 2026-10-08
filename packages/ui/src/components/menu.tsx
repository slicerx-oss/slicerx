'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from '../hooks/use-dismiss'
import { usePlacement } from '../hooks/use-placement'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export interface MenuAnchorProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/** Wrap the trigger and its Menu so the menu positions under the trigger. */
export function MenuAnchor({ className, children, ...rest }: MenuAnchorProps) {
  return (
    <div className={className ? `sx-menu-anchor ${className}` : 'sx-menu-anchor'} {...rest}>
      {children}
    </div>
  )
}

export interface MenuProps {
  open: boolean
  onClose: () => void
  /** Accessible name. */
  label: string
  /** Align to the trigger's start (default) or end. */
  align?: 'start' | 'end'
  /** Render in flow instead of floating, for menus inside a panel. */
  static?: boolean
  className?: string
  children?: ReactNode
}

/**
 * A floating menu. The parent owns the open state; Escape, an outside click, or choosing an item
 * calls onClose. Arrow keys move focus between items. Focus lands on the first item when opened.
 */
export function Menu({ open, onClose, label, align = 'start', static: isStatic, className, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open && !isStatic, onClose)
  const { place, style } = usePlacement(ref, open, align, isStatic)
  // lifted out, the menu is a new element: focus moves to it again
  const lifted = Boolean(place.fixed)
  useEffect(() => {
    if (!open || isStatic) return
    const first = ref.current?.querySelector<HTMLElement>('.sx-menu-item:not(:disabled)')
    first?.focus()
  }, [open, isStatic, lifted])
  if (!open) return null
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('.sx-menu-item:not(:disabled)') ?? [])
    if (!items.length) return
    e.preventDefault()
    const i = items.findIndex((el) => el === document.activeElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }
  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={className ? `sx-menu ${className}` : 'sx-menu'}
      data-align={align === 'start' ? undefined : align}
      data-static={isStatic ? true : undefined}
      data-side={!isStatic && place.up ? 'top' : undefined}
      data-lifted={place.fixed ? true : undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
  // lifted out of a panel that would cut it off: on top of everything, in the window's own layer
  return place.fixed && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: IconName
  /** Shortcut or count shown at the right edge in the mono face. */
  aside?: ReactNode
  /** Checkable items render aria-checked and color the icon purple when on. */
  checked?: boolean
  tone?: 'default' | 'danger'
  children?: ReactNode
}

export function MenuItem({ icon, aside, checked, tone = 'default', className, children, type = 'button', ...rest }: MenuItemProps) {
  return (
    <button
      type={type}
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={className ? `sx-menu-item ${className}` : 'sx-menu-item'}
      data-tone={tone === 'default' ? undefined : tone}
      tabIndex={-1}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : checked !== undefined ? <Icon name="check" data-checkmark={checked ? 'on' : 'off'} /> : null}
      <span>{children}</span>
      {aside !== undefined ? <span className="sx-menu-item-aside">{aside}</span> : null}
    </button>
  )
}

export function MenuHeading({ children }: { children?: ReactNode }) {
  return <div className="sx-menu-heading">{children}</div>
}

export function MenuSeparator() {
  return <hr className="sx-menu-sep" />
}
