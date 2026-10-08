// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import type { ButtonSize, ButtonVariant } from './button'
import { tipAttrs, type TipSpec } from './tooltip'

export interface SplitButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  full?: boolean
  tip?: TipSpec
  /** The menu half: its accessible name, whether its menu is open, and what it does. */
  menuLabel: string
  menuOpen: boolean
  onMenu: () => void
  /** Props for the menu half only, such as its test id. */
  menuProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> & Record<`data-${string}`, string>
  /** The menu itself (a Menu), rendered beside the halves so it anchors to the whole button. */
  menu?: ReactNode
  children?: ReactNode
}

/**
 * One main action and a menu of related ones, as two buttons side by side: Print with Export beside it, Add model with
 * the Vault and shapes. Each half is its own button for keyboard and screen readers. A disabled main half with a tip
 * stays hoverable so the reason shows.
 */
export function SplitButton({ variant = 'default', size = 'md', icon, full, tip, menuLabel, menuOpen, onMenu, menuProps, menu, className, children, disabled, onClick, type = 'button', ...rest }: SplitButtonProps) {
  const soft = tip !== undefined && disabled
  return (
    <div className={className ? `sx-split sx-menu-anchor ${className}` : 'sx-split sx-menu-anchor'} data-full={full ? true : undefined}>
      <button
        type={type}
        className="sx-btn sx-split-main"
        data-variant={variant === 'default' ? undefined : variant}
        data-size={size === 'md' ? undefined : size}
        {...tipAttrs(tip)}
        {...rest}
        disabled={soft ? undefined : disabled}
        aria-disabled={soft ? true : undefined}
        onClick={soft ? (e) => e.preventDefault() : onClick}
      >
        {icon ? <Icon name={icon} /> : null}
        {children}
      </button>
      <button
        type="button"
        className="sx-btn sx-split-menu"
        data-variant={variant === 'default' ? undefined : variant}
        data-size={size === 'md' ? undefined : size}
        data-icon-only
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        {...menuProps}
        onClick={onMenu}
      >
        <Icon name="chevron-down" />
      </button>
      {menu}
    </div>
  )
}
