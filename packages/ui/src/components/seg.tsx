'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { tipAttrs, type TipSpec } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export interface SegOption<V extends string> {
  value: V
  label: ReactNode
  icon?: IconName
  /** Tooltip and accessible name when the label is only an icon; `tip`, when given too, is the tooltip. */
  title?: string
  /** A tooltip for an option whose label already names it; the accessible name stays the label. */
  tip?: TipSpec
  disabled?: boolean
  /** The option's data-testid (docs/test-ids.md). */
  testId?: string
}

export interface SegProps<V extends string> {
  /** Accessible name for the group. */
  label: string
  value: V
  onChange: (value: V) => void
  options: readonly SegOption<V>[]
  size?: 'sm' | 'md'
  /** Fill the container width, options sharing it equally. */
  full?: boolean
  /** Mono face for short codes (0.20, 0.28) and view names. */
  mono?: boolean
  className?: string
}

/** How far an edge with more options past it fades, in px; an option brought into view clears it. */
const FADE = 24

/**
 * A row too wide for its box (five tabs in a phone dialog) scrolls sideways inside it: marked data-overflow, and
 * data-more-start or data-more-end on an edge with options past it, where the row fades rather than cutting an option.
 */
function edges(row: HTMLElement): void {
  const over = row.scrollWidth > row.clientWidth + 1
  row.toggleAttribute('data-overflow', over)
  row.toggleAttribute('data-more-start', over && row.scrollLeft > 1)
  row.toggleAttribute('data-more-end', over && row.scrollLeft + row.clientWidth < row.scrollWidth - 1)
}

/** Scrolls the row, never the page, so the option is fully in view and clear of the fades. */
function reveal(row: HTMLElement, opt: HTMLElement | null | undefined): void {
  if (!opt || row.scrollWidth <= row.clientWidth + 1) return
  const r = row.getBoundingClientRect()
  const o = opt.getBoundingClientRect()
  const start = o.left - r.left - row.clientLeft + row.scrollLeft - (opt.previousElementSibling ? FADE : 0)
  const end = o.right - r.left - row.clientLeft + row.scrollLeft + (opt.nextElementSibling ? FADE : 0)
  if (start < row.scrollLeft) row.scrollLeft = start
  else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth
  edges(row)
}

const rows = new WeakMap<Element, () => void>()
let sizes: ResizeObserver | undefined
/** One observer for every row: a row that starts or stops overflowing marks its edges and keeps its choice in view. */
function watch(row: HTMLElement, onSize: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined
  sizes ??= new ResizeObserver((entries) => {
    for (const e of entries) rows.get(e.target)?.()
  })
  rows.set(row, onSize)
  sizes.observe(row)
  return () => {
    sizes?.unobserve(row)
    rows.delete(row)
  }
}

const chosen = (row: HTMLElement) => row.querySelector<HTMLElement>('[aria-checked="true"]')

/**
 * A segmented control: one of a few values, always visible. Arrow keys move the choice and the focus between options.
 * When the options do not fit (a phone), the row scrolls sideways with a fade at each edge that has more past it.
 * Opening it, a resize or the arrow keys bring the choice into view; a tap never scrolls, so the option stays under
 * the finger (static controls).
 */
export function Seg<V extends string>({ label, value, onChange, options, size = 'md', full, mono, className }: SegProps<V>) {
  const row = useRef<HTMLDivElement>(null)
  // Set by a click: that choice is where the person pressed, so the row does not scroll for it.
  const tapped = useRef(false)
  useEffect(() => {
    const el = row.current
    if (!el) return
    return watch(el, () => {
      edges(el)
      reveal(el, chosen(el))
    })
  }, [])
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    edges(el)
    if (tapped.current) tapped.current = false
    else reveal(el, chosen(el))
  }, [value])
  const move = (from: number, dir: 1 | -1) => {
    const n = options.length
    for (let step = 1; step <= n; step++) {
      const at = (from + dir * step + n) % n
      const opt = options[at]
      if (opt && !opt.disabled) {
        onChange(opt.value)
        const el = row.current
        const btn = el?.children[at] as HTMLElement | undefined
        btn?.focus({ preventScroll: true })
        if (el) reveal(el, btn)
        return
      }
    }
  }
  const hasChecked = options.some((o) => o.value === value)
  const firstEnabled = options.findIndex((o) => !o.disabled)
  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label={label}
      className={className ? `sx-seg ${className}` : 'sx-seg'}
      data-size={size === 'md' ? undefined : size}
      data-full={full ? true : undefined}
      data-mono={mono ? true : undefined}
      onScroll={(e) => edges(e.currentTarget)}
    >
      {options.map((opt, i) => {
        const checked = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={opt.title}
            data-testid={opt.testId}
            {...tipAttrs(opt.tip ?? (opt.title ? { title: opt.title } : undefined))}
            tabIndex={checked || (!hasChecked && i === firstEnabled) ? 0 : -1}
            disabled={opt.disabled}
            onClick={() => {
              tapped.current = !checked
              onChange(opt.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(i, 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(i, -1)
              }
            }}
          >
            {opt.icon ? <Icon name={opt.icon} /> : null}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export interface SwitchProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Accessible name when there is no SwitchRow label. */
  label?: string
  /** purple is the default; green for "on and safe", pink for creator and Vault settings. */
  tone?: 'purple' | 'green' | 'pink'
  disabled?: boolean
  className?: string
  /** `data-testid`, for the agent bridge and the e2e specs (docs/test-ids.md). */
  testId?: string
}

/** An on or off toggle. */
export function Switch({ id, checked, onChange, label, tone = 'purple', disabled, className, testId }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={className ? `sx-switch ${className}` : 'sx-switch'}
      data-tone={tone === 'purple' ? undefined : tone}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    />
  )
}

export interface SwitchRowProps extends SwitchProps {
  /** The visible label; the switch id links it. */
  label: string
  /** One line under the label, in the dim color. */
  detail?: ReactNode
  /** A small icon before the label. */
  icon?: IconName
}

/** A label on the left and a switch on the right, for settings lists. */
export function SwitchRow({ label, detail, icon, className, ...sw }: SwitchRowProps) {
  return (
    <div className={className ? `sx-switchrow ${className}` : 'sx-switchrow'}>
      <label htmlFor={sw.id} data-icon={icon ? true : undefined}>
        {icon ? <Icon name={icon} size={16} /> : null}
        {label}
        {detail ? <small>{detail}</small> : null}
      </label>
      <Switch {...sw} />
    </div>
  )
}
