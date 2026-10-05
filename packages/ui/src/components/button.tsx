// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { tipAttrs, type TipSpec } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonBase {
  /** primary uses the gradient: one per screen. */
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  /** Icon after the label instead of before it. */
  iconEnd?: IconName
  /** Stretch to the container width. */
  full?: boolean
  /** Toggle state; renders aria-pressed. */
  pressed?: boolean
  /** Feature tooltip: a registry id or one-off text. A disabled button with a tip stays hoverable (aria-disabled). */
  tip?: TipSpec
  children?: ReactNode
}

export interface ButtonProps extends ButtonBase, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {}

/** A button. Icon-only buttons must pass aria-label. */
export function Button({ variant = 'default', size = 'md', icon, iconEnd, full, pressed, className, children, type = 'button', tip, disabled, onClick, ...rest }: ButtonProps) {
  const soft = tip !== undefined && disabled
  const iconOnly = !children && (icon || iconEnd) ? true : undefined
  return (
    <button
      type={type}
      className={className ? `sx-btn ${className}` : 'sx-btn'}
      data-variant={variant === 'default' ? undefined : variant}
      data-size={size === 'md' ? undefined : size}
      data-icon-only={iconOnly}
      data-full={full ? true : undefined}
      aria-pressed={pressed}
      {...tipAttrs(tip)}
      {...rest}
      disabled={soft ? undefined : disabled}
      aria-disabled={soft ? true : undefined}
      onClick={soft ? (e) => e.preventDefault() : onClick}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </button>
  )
}

export interface ButtonLinkProps extends ButtonBase, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {}

/** A link styled as a button, for navigation (downloads, source, docs). */
export function ButtonLink({ variant = 'default', size = 'md', icon, iconEnd, full, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a
      className={className ? `sx-btn ${className}` : 'sx-btn'}
      data-variant={variant === 'default' ? undefined : variant}
      data-size={size === 'md' ? undefined : size}
      data-full={full ? true : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </a>
  )
}

export interface LinkButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: IconName
  /** For disclosure links: rotates the chevron and sets aria-expanded. */
  expanded?: boolean
  children?: ReactNode
}

/** A text button with no box, as used for "Show expert settings" style disclosures. */
export function LinkButton({ icon, expanded, className, children, type = 'button', ...rest }: LinkButtonProps) {
  return (
    <button type={type} className={className ? `sx-linkbtn ${className}` : 'sx-linkbtn'} aria-expanded={expanded} {...rest}>
      {children}
      {icon ? <Icon name={icon} /> : expanded !== undefined ? <Icon name="chevron-down" /> : null}
    </button>
  )
}
