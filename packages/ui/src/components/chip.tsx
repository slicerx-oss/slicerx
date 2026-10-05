// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

/** vault and free are the named chips from the concept; the color names cover the rest. */
export type ChipTone = 'neutral' | 'vault' | 'free' | 'purple' | 'pink' | 'cyan' | 'green' | 'orange' | 'red'

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone
  icon?: IconName
  /** Numbers, versions and file names in the mono face. */
  mono?: boolean
  children?: ReactNode
}

/** A small label: file kind, tier, tag, count. Not a status; use Pill for state. */
export function Chip({ tone = 'neutral', icon, mono, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={className ? `sx-chip ${className}` : 'sx-chip'}
      data-tone={tone === 'neutral' ? undefined : tone}
      data-mono={mono ? true : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  )
}

export type PillState = 'ok' | 'run' | 'warn' | 'bad' | 'off'

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  state: PillState
  children?: ReactNode
}

/** A status dot with a word: printer state, job state, connection state. */
export function Pill({ state, className, children, ...rest }: PillProps) {
  return (
    <span className={className ? `sx-pill ${className}` : 'sx-pill'} data-state={state} {...rest}>
      {children}
    </span>
  )
}

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/** A keyboard key cap. Pass one key per Kbd; combine with plain text between them. */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd className={className ? `sx-kbd ${className}` : 'sx-kbd'} {...rest}>
      {children}
    </kbd>
  )
}

export interface EyebrowProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/** Small uppercase section label. */
export function Eyebrow({ className, children, ...rest }: EyebrowProps) {
  return (
    <div className={className ? `sx-eyebrow ${className}` : 'sx-eyebrow'} {...rest}>
      {children}
    </div>
  )
}
