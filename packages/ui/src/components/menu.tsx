'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
/** How close a lifted-out menu may come to the window's edge, px. */
const EDGE = 8

/** Where a menu of this size opens at a point: down and right of it, flipped up or left when that side is short, inside the window. */
export function placeAt(at: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const left = at.x + size.width + EDGE > view.width ? at.x - size.width : at.x
  const top = at.y + size.height + EDGE > view.height ? at.y - size.height : at.y
  return {
    left: Math.max(EDGE, Math.min(left, view.width - size.width - EDGE)),
    top: Math.max(EDGE, Math.min(top, view.height - size.height - EDGE)),
  }
}

/** Where the menu goes: under or over its trigger, and, when a scrolling panel would cut it off, lifted out of the panel. */
type Place = { up: boolean; max?: number; fixed?: { left: number; top?: number; bottom?: number } }

export interface MenuProps {
  open: boolean
  onClose: () => void
  /** Accessible name. */
  label: string
  /** Align to the trigger's start (default) or end. */
  align?: 'start' | 'end'
  /** Render in flow instead of floating, for menus inside a panel. */
  static?: boolean
  /** Open at this window point instead of under the trigger (a context menu). */
  at?: { x: number; y: number } | undefined
  className?: string
  children?: ReactNode
}

/**
 * A floating menu. The parent owns the open state; Escape, an outside click, or choosing an item
 * calls onClose. Arrow keys move focus between items. Focus lands on the first item when opened.
 */
export function Menu({ open, onClose, label, align = 'start', static: isStatic, at, className, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Place>({ up: false })
  useDismiss(ref, open && !isStatic, onClose)
  // A menu opened near the bottom of a scrolling panel or the window opens upward when there is more room
  // there, and scrolls itself when neither side fits it, so no item is cut off. One a panel would cut off at the side
  // (the Export menu at the right end of the side pane) is lifted out of the panel and kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!open || isStatic || !el || !anchor || place.fixed || at) return
    const a = anchor.getBoundingClientRect()
    let top = 0
    let bottom = window.innerHeight
    let left = 0
    let right = window.innerWidth
    for (let p = anchor.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowY === 'visible' && s.overflowX === 'visible') continue
      const r = p.getBoundingClientRect()
      top = Math.max(top, r.top)
      bottom = Math.min(bottom, r.bottom)
      left = Math.max(left, r.left)
      right = Math.min(right, r.right)
    }
    const width = el.offsetWidth
    const height = el.scrollHeight
    const start = align === 'start' ? a.left : a.right - width
    const cutAtSide = start < left - 1 || start + width > right + 1
    if (cutAtSide) {
      // lifted out: placed against the window, under the trigger or over it, wherever there is more room
      const below = window.innerHeight - a.bottom - GAP - EDGE
      const above = a.top - GAP - EDGE
      const up = height > below && above > below
      const room = Math.floor(up ? above : below)
      const x = Math.min(Math.max(EDGE, start), window.innerWidth - width - EDGE)
      setPlace({
        up,
        ...(height > room ? { max: Math.max(MIN_HEIGHT, room) } : {}),
        fixed: up ? { left: x, bottom: window.innerHeight - a.top + GAP } : { left: x, top: a.bottom + GAP },
      })
      return
    }
    const below = bottom - a.bottom - GAP
    const above = a.top - top - GAP
    const up = height > below && above > below
    const room = Math.floor(up ? above : below)
    setPlace(height > room ? { up, max: Math.max(MIN_HEIGHT, room) } : { up })
  }, [open, isStatic, align, place.fixed, at])
  // at a point: placed against the window, flipped at its edges, scrolling when taller than the window
  const atX = at?.x
  const atY = at?.y
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || isStatic || !el || atX === undefined || atY === undefined) return
    const room = window.innerHeight - 2 * EDGE
    const height = Math.min(el.scrollHeight, room)
    const p = placeAt({ x: atX, y: atY }, { width: el.offsetWidth, height }, { width: window.innerWidth, height: window.innerHeight })
    setPlace({ up: false, ...(el.scrollHeight > room ? { max: room } : {}), fixed: { left: p.left, top: p.top } })
  }, [open, isStatic, atX, atY])
  // closed, it measures again next time
  useEffect(() => {
    if (!open) setPlace({ up: false })
  }, [open])
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
  const style: CSSProperties | undefined = isStatic
    ? undefined
    : {
        ...(place.max !== undefined ? { maxHeight: place.max, overflowY: 'auto' } : {}),
        ...(place.fixed ? { position: 'fixed', left: place.fixed.left, right: 'auto', top: place.fixed.top ?? 'auto', bottom: place.fixed.bottom ?? 'auto' } : {}),
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
      style={style && Object.keys(style).length ? style : undefined}
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
