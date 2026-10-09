'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ReactNode } from 'react'
import { tipAttrs, type TipSpec } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export interface SegOption<V extends string> {
  value: V
  label: ReactNode
  icon?: IconName
  /** Tooltip and accessible name when the label is only an icon. */
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

/** A segmented control: one of a few values, always visible. Arrow keys move between options. */
export function Seg<V extends string>({ label, value, onChange, options, size = 'md', full, mono, className }: SegProps<V>) {
  const move = (from: number, dir: 1 | -1) => {
    const n = options.length
    for (let step = 1; step <= n; step++) {
      const opt = options[(from + dir * step + n) % n]
      if (opt && !opt.disabled) {
        onChange(opt.value)
        return
      }
    }
  }
  const hasChecked = options.some((o) => o.value === value)
  const firstEnabled = options.findIndex((o) => !o.disabled)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={className ? `sx-seg ${className}` : 'sx-seg'}
      data-size={size === 'md' ? undefined : size}
      data-full={full ? true : undefined}
      data-mono={mono ? true : undefined}
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
            {...tipAttrs(opt.title ? { title: opt.title } : opt.tip)}
            tabIndex={checked || (!hasChecked && i === firstEnabled) ? 0 : -1}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
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
