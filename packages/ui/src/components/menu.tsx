'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { useDismiss } from '../hooks/use-dismiss'
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

/** Space between the trigger and the menu, px, as in styles.css. */
const GAP = 4
/** A menu short of room still shows a few items and scrolls. */
const MIN_HEIGHT = 120

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
  const [place, setPlace] = useState<{ up: boolean; max?: number }>({ up: false })
  useDismiss(ref, open && !isStatic, onClose)
  // A menu opened near the bottom of a scrolling panel or the window opens upward when there is more room
  // there, and scrolls itself when neither side fits it, so no item is cut off.
  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!open || isStatic || !el || !anchor) return
    const a = anchor.getBoundingClientRect()
    let top = 0
    let bottom = window.innerHeight
    for (let p = anchor.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowY === 'visible' && s.overflowX === 'visible') continue
      const r = p.getBoundingClientRect()
      top = Math.max(top, r.top)
      bottom = Math.min(bottom, r.bottom)
    }
    const below = bottom - a.bottom - GAP
    const above = a.top - top - GAP
    const height = el.scrollHeight
    const up = height > below && above > below
    const room = Math.floor(up ? above : below)
    setPlace(height > room ? { up, max: Math.max(MIN_HEIGHT, room) } : { up })
  }, [open, isStatic])
  useEffect(() => {
    if (!open || isStatic) return
    const first = ref.current?.querySelector<HTMLElement>('.sx-menu-item:not(:disabled)')
    first?.focus()
  }, [open, isStatic])
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
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={className ? `sx-menu ${className}` : 'sx-menu'}
      data-align={align === 'start' ? undefined : align}
      data-static={isStatic ? true : undefined}
      data-side={!isStatic && place.up ? 'top' : undefined}
      style={!isStatic && place.max !== undefined ? { maxHeight: place.max, overflowY: 'auto' } : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
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
