'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A menu at a point: a right click, a long press on touch, Shift+F10 or the menu key. The caller binds the trigger
// with useContextMenu and renders ContextMenu with its own items; an icon row of the likeliest verbs can lead it.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { tipAttrs } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { Menu, placeAt } from './menu'

/** A press held this long without moving opens the menu on touch, ms. */
export const LONG_PRESS_MS = 500
/** A press that moves farther than this is a drag or a scroll, not a long press, px. */
export const LONG_PRESS_SLOP = 8

export interface MenuPoint {
  x: number
  y: number
}

export { placeAt }

/** Shift+F10 or the menu key: the keyboard's right click. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

/** A long press stays a long press while the finger stays within the slop. */
export function pressStays(from: MenuPoint, now: MenuPoint): boolean {
  return Math.hypot(now.x - from.x, now.y - from.y) <= LONG_PRESS_SLOP
}

export interface ContextMenuBind {
  onContextMenu: (e: MouseEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  'data-ctx': ''
}

/**
 * The open point and the trigger's handlers. `open(target)` is called with the element the menu is for, before it
 * opens, so the caller can select it; return false to keep the menu shut. Focus goes back to the trigger on close.
 */
export function useContextMenu<T = HTMLElement>(open?: (target: HTMLElement, data: T | undefined) => boolean | void, data?: T) {
  const [at, setAt] = useState<MenuPoint | null>(null)
  const back = useRef<HTMLElement | null>(null)
  const press = useRef<{ from: MenuPoint; timer: ReturnType<typeof setTimeout>; target: HTMLElement } | null>(null)
  const show = useCallback(
    (target: HTMLElement, point: MenuPoint) => {
      if (open?.(target, data) === false) return
      back.current = target
      setAt(point)
    },
    [open, data],
  )
  const close = useCallback(() => {
    setAt(null)
    const el = back.current
    back.current = null
    // after the menu leaves, so its own focus handling is done
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }, [])
  const stop = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => stop, [])
  const bind: ContextMenuBind = {
    onContextMenu: (e) => {
      e.preventDefault()
      stop()
      show(e.currentTarget, { x: e.clientX, y: e.clientY })
    },
    onKeyDown: (e) => {
      if (!isMenuKey(e)) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      show(e.currentTarget, { x: r.left + Math.min(24, r.width / 2), y: r.bottom })
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return
      stop()
      const target = e.currentTarget
      const from = { x: e.clientX, y: e.clientY }
      press.current = { from, target, timer: setTimeout(() => {
        press.current = null
        show(target, from)
      }, LONG_PRESS_MS) }
    },
    onPointerMove: (e) => {
      if (press.current && !pressStays(press.current.from, { x: e.clientX, y: e.clientY })) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    'data-ctx': '',
  }
  return { at, bind, close, show }
}

export interface ContextMenuProps {
  /** The point it opens at, or null when shut. */
  at: MenuPoint | null
  onClose: () => void
  /** Accessible name, such as "Bracket" or "Fillet 3". */
  label: string
  className?: string
  children?: ReactNode
}

export function ContextMenu({ at, onClose, label, className, children }: ContextMenuProps) {
  return (
    <Menu open={at !== null} onClose={onClose} label={label} at={at ?? undefined} className={className ? `sx-ctx ${className}` : 'sx-ctx'}>
      {children}
    </Menu>
  )
}

export interface MenuIconProps {
  icon: IconName
  /** The verb, read out and shown in the tip. */
  label: string
  /** A shortcut for the tip. */
  shortcut?: string
  disabled?: boolean
  /** Why it is off, shown in the tip instead of a silent gray. */
  reason?: string
  pressed?: boolean
  tone?: 'default' | 'danger'
  onClick: () => void
  [data: `data-${string}`]: string | undefined
}

/** The verbs used most, as one row of icon buttons at the top of a menu. Arrow keys move through them with the items. */
export function MenuIconRow({ children }: { children?: ReactNode }) {
  return (
    <div className="sx-menu-icons" role="group">
      {children}
    </div>
  )
}

export function MenuIcon({ icon, label, shortcut, disabled, reason, pressed, tone = 'default', onClick, ...rest }: MenuIconProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="sx-menu-item sx-menu-icon"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      data-tone={tone === 'default' ? undefined : tone}
      tabIndex={-1}
      {...tipAttrs({ title: label, ...(disabled && reason ? { body: reason } : {}), ...(shortcut ? { key: shortcut } : {}) })}
      onClick={disabled ? undefined : onClick}
      {...rest}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}
