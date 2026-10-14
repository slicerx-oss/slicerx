// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HTMLAttributes, ReactNode } from 'react'

export interface SettingRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** The row's element: an li inside a list of settings, a div elsewhere. */
  as?: 'li' | 'div'
  /** The label, usually a label element pointing at the control. */
  label: ReactNode
  /** The control: a number field, a select, a switch or a segmented choice. It ends at the row's right edge. */
  control: ReactNode
  /** What sits in the left rail: the changed dot, the pin. Never inside the label, so the label never moves. */
  mark?: ReactNode
  /** What sits in the right rail: the reset button of a changed row. */
  reset?: ReactNode
  /** No rails: for a list where no row has a mark or a reset (Settings > Controls). The columns are otherwise the same. */
  bare?: boolean
  /** The label above a control that is full width by nature (a template, a prose field), for the whole row. */
  stack?: boolean
  /** Lines under the row (a note, chips), from the label's edge to the row's right edge. */
  children?: ReactNode
}

/**
 * One settings row: mark rail, label, control, reset rail (--w-mark, 1fr, auto, --w-reset) with one gap. Every control
 * ends at the same right edge and every label starts at the same x, changed or not, pinned or not.
 */
export function SettingRow({ as = 'div', label, control, mark, reset, bare, stack, className, children, ...rest }: SettingRowProps) {
  const Tag = as
  return (
    <Tag className={className ? `sx-setrow ${className}` : 'sx-setrow'} data-bare={bare ? true : undefined} data-stack={stack ? true : undefined} {...rest}>
      {bare ? null : <span className="sx-setrow-mark">{mark}</span>}
      {label}
      {control}
      {bare ? null : <span className="sx-setrow-reset">{reset}</span>}
      {children}
    </Tag>
  )
}
