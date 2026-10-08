// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { tipAttrs, type TipSpec } from './tooltip'

export interface ChipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: IconName
  /** A chevron after the label for a chip that opens a menu or popover. */
  menu?: boolean
  /** Toggle state; renders aria-pressed. */
  pressed?: boolean
  /** Numbers in the label line up (tabular nums). */
  numeric?: boolean
  tip?: TipSpec
  children?: ReactNode
}

/** A chip that does something: a value you can change in place, such as the nozzle or the plate type. */
export function ChipButton({ icon, menu, pressed, numeric, tip, className, children, type = 'button', ...rest }: ChipButtonProps) {
  return (
    <button
      type={type}
      className={className ? `sx-chip-btn ${className}` : 'sx-chip-btn'}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-pressed={pressed}
      data-numeric={numeric ? true : undefined}
      {...tipAttrs(tip)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <span className="sx-chip-btn-label">{children}</span>
      {menu ? <Icon name="chevron-down" size={14} className="sx-chip-btn-caret" /> : null}
    </button>
  )
}
