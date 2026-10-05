'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from '../icons/icon'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Which side carries the hairline: a left panel has it on the right. */
  edge?: 'left' | 'right' | 'none'
  children?: ReactNode
}

/** A scrolling side pane built from Blocks separated by hairlines. */
export function Panel({ edge = 'none', className, children, ...rest }: PanelProps) {
  return (
    <div className={className ? `sx-panel ${className}` : 'sx-panel'} data-edge={edge === 'none' ? undefined : edge} {...rest}>
      {children}
    </div>
  )
}

export interface BlockProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  /** Mono text at the right of the title: a value, a count, a unit. */
  aside?: ReactNode
  /** When set, the title becomes a disclosure button and the body hides when false. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Stable id for the disclosure button and its region. */
  id?: string
  children?: ReactNode
}

/** One hairline-bounded section of a Panel, with an optional title row and disclosure. */
export function Block({ title, aside, expanded, onExpandedChange, id, className, children, ...rest }: BlockProps) {
  const collapsible = expanded !== undefined
  const hidden = collapsible && !expanded
  const regionId = id ? `${id}-body` : undefined
  return (
    <section className={className ? `sx-block ${className}` : 'sx-block'} data-collapsed={hidden ? true : undefined} {...rest}>
      {title !== undefined || aside !== undefined ? (
        <div className="sx-block-h">
          {collapsible ? (
            <button type="button" id={id} className="sx-block-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={() => onExpandedChange?.(!expanded)}>
              <Icon name="chevron-down" />
              <h3>{title}</h3>
            </button>
          ) : (
            <h3>{title}</h3>
          )}
          {aside !== undefined ? <span className="sx-block-aside">{aside}</span> : null}
        </div>
      ) : null}
      {hidden ? null : (
        <div id={regionId} role={collapsible ? 'region' : undefined} aria-labelledby={collapsible ? id : undefined}>
          {children}
        </div>
      )}
    </section>
  )
}

export interface KeyValueProps {
  /** Up to four items read well; each is a value with a dim caption under it. */
  items: readonly { value: ReactNode; label: ReactNode }[]
  className?: string
}

/** A row of mono values with captions, separated by hairlines: time, grams, cost. */
export function KeyValues({ items, className }: KeyValueProps) {
  return (
    <div className={className ? `sx-kv ${className}` : 'sx-kv'} style={{ ['--cols' as string]: items.length }}>
      {items.map((it, i) => (
        <div key={i}>
          <b>{it.value}</b>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  )
}
