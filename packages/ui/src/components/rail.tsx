'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { useEdgeGlow } from '../hooks/use-edge-glow'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export interface RailItem {
  id: string
  label: string
  icon: IconName
  /** Count or short mono text at the right; shows as a dot when collapsed. */
  badge?: ReactNode
  active?: boolean
  disabled?: boolean
  /** Link items render as anchors. */
  href?: string
}

export interface RailProps {
  side: 'left' | 'right'
  /** Accessible name and the title shown when expanded. */
  label: string
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Icon items at the top; visible in both states. */
  items?: readonly RailItem[]
  onSelect?: (item: RailItem) => void
  /** Expand as an overlay after the pointer rests on the collapsed rail (hover intent). */
  peekOnHover?: boolean
  /** Delay before a hover peek opens, in ms. */
  peekDelay?: number
  /** Set while a drag hovers this rail: the edge glows pink as a drop target. */
  dropActive?: boolean
  /** Rendered only when expanded, under the items. */
  children?: ReactNode
  /** Rendered only when expanded, pinned at the bottom. */
  footer?: ReactNode
  className?: string
  /** Inline style, such as a --w-side the parent sets while the person resizes the rail. */
  style?: CSSProperties
  /** A draggable edge. It replaces the pointer-proximity glow. */
  edge?: ReactNode
  /** The rail element, for measuring a drag from the parent. */
  railRef?: React.RefObject<HTMLElement | null>
  /** False where an EdgeTab shuts and opens the rail instead: the header's own toggle is not drawn. */
  toggle?: boolean
}

/**
 * A collapsible sidebar. At rest it is a thin icon rail; it expands on
 * the toggle, on hover intent (as an overlay that does not move the layout), or when the parent
 * decides the window is wide enough. The inner edge glows as the pointer approaches. The parent
 * owns and remembers the collapsed state per workspace.
 */
export function Rail({ side, label, collapsed, onCollapsedChange, items = [], onSelect, peekOnHover = true, peekDelay = 320, dropActive, children, footer, className, style, edge, railRef, toggle = true }: RailProps) {
  const own = useRef<HTMLElement>(null)
  const ref = railRef ?? own
  const [peek, setPeek] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const glow = useRef<HTMLSpanElement>(null)
  useEdgeGlow(ref, { side, target: glow, disabled: Boolean(dropActive) || Boolean(edge) })

  // A peek ends when the rail is expanded for real or the pointer leaves.
  useEffect(() => {
    if (!collapsed) setPeek(false)
  }, [collapsed])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const showExpanded = !collapsed || peek
  const onEnter = (e: PointerEvent<HTMLElement>) => {
    if (!peekOnHover || !collapsed || e.pointerType === 'touch') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPeek(true), peekDelay)
  }
  const onLeave = () => {
    window.clearTimeout(timer.current)
    setPeek(false)
  }

  const rail = (
    <aside
      ref={ref}
      className={className ? `sx-rail ${className}` : 'sx-rail'}
      data-side={side}
      data-collapsed={showExpanded ? undefined : true}
      data-peek={peek ? true : undefined}
      data-drop={dropActive ? 'active' : undefined}
      aria-label={label}
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <span ref={glow} className="sx-rail-glow" aria-hidden="true" />
      {edge}
      <div className="sx-rail-head">
        {side === 'right' ? null : <span className="sx-rail-title">{label}</span>}
        {toggle ? <button
          type="button"
          className="sx-rail-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          onClick={() => {
            setPeek(false)
            onCollapsedChange(!collapsed)
          }}
        >
          <Icon name="chevron-down" />
        </button> : null}
        {side === 'right' ? <span className="sx-rail-title">{label}</span> : null}
      </div>
      {items.length ? (
        <nav className="sx-rail-items" aria-label={label}>
          {items.map((item) => {
            const common = {
              className: 'sx-rail-item',
              'aria-current': item.active ? ('true' as const) : undefined,
              'data-badge': item.badge !== undefined && item.badge !== null ? true : undefined,
              title: showExpanded ? undefined : item.label,
              'aria-label': showExpanded ? undefined : item.label,
            }
            const inner = (
              <>
                <Icon name={item.icon} />
                <span className="sx-rail-item-label">{item.label}</span>
                {item.badge !== undefined ? <span className="sx-rail-item-badge">{item.badge}</span> : null}
              </>
            )
            return item.href ? (
              <a key={item.id} href={item.href} {...common} onClick={() => onSelect?.(item)}>
                {inner}
              </a>
            ) : (
              <button key={item.id} type="button" disabled={item.disabled} {...common} onClick={() => onSelect?.(item)}>
                {inner}
              </button>
            )
          })}
        </nav>
      ) : null}
      <div className="sx-rail-body">{showExpanded ? children : null}</div>
      {footer ? <div className="sx-rail-foot">{footer}</div> : null}
    </aside>
  )

  // While peeking, keep the collapsed width in the layout and float the expanded rail over it.
  if (peek) {
    return (
      <div className="sx-rail-slot" data-side={side}>
        {rail}
      </div>
    )
  }
  return rail
}
