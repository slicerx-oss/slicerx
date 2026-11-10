'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A menu at a point: a right click, a long press on touch, Shift+F10 or the menu key. The caller binds the trigger
// with useContextMenu and renders ContextMenu with its own items; an icon row of the likeliest verbs can lead it.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { tipAttrs } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { Menu, MenuHeading, MenuItem, MenuSeparator, placeAt } from './menu'

/** A press held this long without moving opens the menu on touch, ms. */
export const LONG_PRESS_MS = 500
/** A press that moves farther than this is a drag or a scroll, not a long press, px. */
export const LONG_PRESS_SLOP = 8
/**
 * A timer or a frame that runs this long late, ms, ran after a long task: the browser may still be handing the page
 * finger moves made meanwhile, and they can take a few frames more to arrive. So once the page has been busy, a press
 * counts as held only after frames have run on time for this long again.
 */
const LATE_FRAME_MS = 100
/** The most a busy page holds a long press back past its half second, ms. */
const HOLD_WAIT_MAX_MS = 1000

export interface MenuPoint {
  x: number
  y: number
}

export { placeAt }

/** Shift+F10 or the menu key: the keyboard's right click. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

/**
 * Whether a closed menu gives focus back to its trigger: only while nothing else has it (it was in the menu, which is
 * gone). A person who has gone on to another control between the close and the next frame keeps it there.
 */
export function focusGoesBack(active: Element | null, body: Element | null): boolean {
  return !active || active === body || !active.isConnected
}

/** A long press stays a long press while the finger stays within the slop. */
export function pressStays(from: MenuPoint, now: MenuPoint): boolean {
  return Math.hypot(now.x - from.x, now.y - from.y) <= LONG_PRESS_SLOP
}

export interface LongPressBind {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  /** Swallows the click that follows a long press, so lifting the finger does not also press the control. */
  onClickCapture: (e: MouseEvent<HTMLElement>) => void
}

/**
 * Touch has no right click, so a press held for about half a second, without moving or scrolling, stands in for it.
 * `fire` gets the pressed element and the point of the press. A mouse or a pen does nothing here. Spread `bind` on the
 * element that also handles `onContextMenu`, and `cancel` when that handler runs so the two never both open it.
 */
export function useLongPress(fire: (target: HTMLElement, point: MenuPoint) => void): { bind: LongPressBind; cancel: () => void } {
  const press = useRef<{ from: MenuPoint; t0: number; timer: ReturnType<typeof setTimeout>; held?: () => void } | null>(null)
  const fired = useRef(false)
  const latest = useRef(fire)
  latest.current = fire
  const cancel = useCallback(() => {
    if (press.current) {
      clearTimeout(press.current.timer)
      window.removeEventListener('scroll', cancel, true)
    }
    press.current = null
  }, [])
  useEffect(() => cancel, [cancel])
  const bind: LongPressBind = {
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return
      cancel()
      fired.current = false
      const target = e.currentTarget
      const from = { x: e.clientX, y: e.clientY }
      window.addEventListener('scroll', cancel, true)
      const p: NonNullable<typeof press.current> = {
        from,
        t0: performance.now(),
        timer: setTimeout(() => {
          // The browser hands a moving finger to the page once a frame, so a busy page can still hold a move made
          // before now: the press counts as held on the next frame, or at the lift if that comes first (it comes after
          // those moves), unless a move has ended it by then. After a long task the moves can take a few frames more,
          // so the hold waits until frames have run on time for a while. A drag on a slider while the page is busy
          // drawing stays a drag.
          if (press.current !== p) return
          p.held = () => {
            if (press.current !== p) return
            press.current = null
            window.removeEventListener('scroll', cancel, true)
            fired.current = true
            latest.current(target, from)
          }
          const start = performance.now()
          let last = start
          // when the page last ran late; a timer that runs late ran after a long task, which is just when moves wait
          let busy = start - p.t0 > LONG_PRESS_MS + LATE_FRAME_MS ? start : -Infinity
          const settle = (): void => {
            if (press.current !== p) return
            const now = performance.now()
            if (now - last > LATE_FRAME_MS) busy = now
            last = now
            if (now - busy < LATE_FRAME_MS && now - start < HOLD_WAIT_MAX_MS) requestAnimationFrame(settle)
            else p.held?.()
          }
          requestAnimationFrame(settle)
        }, LONG_PRESS_MS),
      }
      press.current = p
    },
    onPointerMove: (e) => {
      if (press.current && !pressStays(press.current.from, { x: e.clientX, y: e.clientY })) cancel()
    },
    // a lift while the hold waits on a frame comes after any moves before it, so the press was held
    onPointerUp: () => (press.current?.held ? press.current.held() : cancel()),
    onPointerCancel: cancel,
    onClickCapture: (e) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
  return { bind, cancel }
}

export interface ContextMenuBind extends LongPressBind {
  onContextMenu: (e: MouseEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  'data-ctx': ''
}

/**
 * The open point and the trigger's handlers. `open(target)` is called with the element the menu is for, before it
 * opens, so the caller can select it; return false to keep the menu shut. Focus goes back to the trigger on close.
 */
export function useContextMenu<T = HTMLElement>(open?: (target: HTMLElement, data: T | undefined) => boolean | void, data?: T) {
  const [at, setAt] = useState<MenuPoint | null>(null)
  const back = useRef<HTMLElement | null>(null)
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
    if (el?.isConnected)
      requestAnimationFrame(() => {
        if (el.isConnected && focusGoesBack(document.activeElement, document.body)) el.focus({ preventScroll: true })
      })
  }, [])
  const { bind: pressBind, cancel } = useLongPress(show)
  const bind: ContextMenuBind = {
    ...pressBind,
    onContextMenu: (e) => {
      e.preventDefault()
      cancel()
      show(e.currentTarget, { x: e.clientX, y: e.clientY })
    },
    onKeyDown: (e) => {
      if (!isMenuKey(e)) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      show(e.currentTarget, { x: r.left + Math.min(24, r.width / 2), y: r.bottom })
    },
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
  /** A test id for the open menu, and what it is for (`data-target`). */
  testId?: string
  target?: string
  children?: ReactNode
}

export function ContextMenu({ at, onClose, label, className, testId, target, children }: ContextMenuProps) {
  return (
    <Menu open={at !== null} onClose={onClose} label={label} at={at ?? undefined} className={className ? `sx-ctx ${className}` : 'sx-ctx'} {...(testId ? { testId } : {})} {...(target ? { target } : {})}>
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

/** One item of a menu built from data: the selection bar's menu and the context menus share one list. */
export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  /** A shortcut, shown at the right edge. */
  shortcut?: string
  disabled?: boolean
  /** Why it is off, in its tip instead of a silent gray. */
  reason?: string
  danger?: boolean
  testId?: string
  /** A group under a heading (Move to plate: one item per plate). */
  children?: MenuEntry[]
  run?: () => void
}

/** The items for a list of entries, closing the menu before each runs. A separator goes between groups. */
export function MenuItems({ items, onClose }: { items: readonly MenuEntry[]; onClose: () => void }) {
  return (
    <>
      {items.map((it) =>
        it.children ? (
          <span key={it.id} role="group" aria-label={it.label} className="sx-menu-group">
            <MenuSeparator />
            <MenuHeading>{it.label}</MenuHeading>
            <MenuItems items={it.children} onClose={onClose} />
          </span>
        ) : (
          <MenuItem
            key={it.id}
            {...(it.icon ? { icon: it.icon } : {})}
            {...(it.shortcut ? { aside: it.shortcut } : {})}
            tone={it.danger ? 'danger' : 'default'}
            aria-disabled={it.disabled || undefined}
            {...(it.testId ? { 'data-testid': it.testId } : {})}
            {...(it.disabled && it.reason ? tipAttrs({ title: it.label, reason: it.reason }) : {})}
            onClick={
              it.disabled
                ? undefined
                : () => {
                    onClose()
                    it.run?.()
                  }
            }
          >
            {it.label}
          </MenuItem>
        ),
      )}
    </>
  )
}
