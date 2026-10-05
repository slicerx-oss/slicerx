// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Every control needs a stable id. */
  id: string
  /** Mono face for numbers, temperatures, file names. */
  mono?: boolean
  /** Unit shown at the right edge: mm, C, g, %, mm/s. */
  unit?: string
  /** Icon shown at the left edge (search fields). */
  icon?: IconName
  size?: 'sm' | 'md'
}

/** A text or number input. With unit or icon it renders inside a positioned wrapper. */
export function Input({ id, mono, unit, icon, size = 'md', className, ...rest }: InputProps) {
  const el = (
    <input
      id={id}
      className={className ? `sx-input ${className}` : 'sx-input'}
      data-mono={mono || unit ? true : undefined}
      data-size={size === 'md' ? undefined : size}
      {...rest}
    />
  )
  if (!unit && !icon) return el
  return (
    <span className="sx-inputwrap" data-lead={icon ? true : undefined}>
      {icon ? (
        <span className="sx-inputwrap-lead">
          <Icon name={icon} size={15} />
        </span>
      ) : null}
      {el}
      {unit ? (
        <span className="sx-inputwrap-unit" aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </span>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string
  mono?: boolean
}

export function Textarea({ id, mono, className, ...rest }: TextareaProps) {
  return <textarea id={id} className={className ? `sx-textarea ${className}` : 'sx-textarea'} data-mono={mono ? true : undefined} {...rest} />
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  id: string
  size?: 'sm' | 'md'
  children?: ReactNode
}

/** A native select with the Nocturne chrome. Options are plain option elements. */
export function Select({ id, size = 'md', className, children, ...rest }: SelectProps) {
  return (
    <span className="sx-selectwrap">
      <select id={id} className={className ? `sx-select ${className}` : 'sx-select'} data-size={size === 'md' ? undefined : size} {...rest}>
        {children}
      </select>
    </span>
  )
}

export interface FieldProps {
  /** The id of the control inside, so the label points at it. */
  htmlFor: string
  label: ReactNode
  /** Right-aligned value or unit next to the label, for sliders and readouts. */
  aside?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children?: ReactNode
}

/** Label, control, and an optional hint or error line. */
export function Field({ htmlFor, label, aside, hint, error, className, children }: FieldProps) {
  return (
    <div className={className ? `sx-field ${className}` : 'sx-field'}>
      <label className="sx-field-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {aside !== undefined ? <span className="sx-mono">{aside}</span> : null}
      </label>
      {children}
      {error ? (
        <div className="sx-field-hint" data-tone="error" id={`${htmlFor}-error`}>
          {error}
        </div>
      ) : hint ? (
        <div className="sx-field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}
