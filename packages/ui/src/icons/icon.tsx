'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SVGProps } from 'react'
import { useTheme } from '../theme-provider'
import { ICON_PATHS, type IconName } from './icon-paths'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName
  /** Pixel size; the default is the .sx-ic size (18px). */
  size?: number
  /** Accessible name. Without one the icon is decorative and hidden from readers. */
  label?: string
}

/** One line icon from the SlicerX set, drawn on a 24px grid at stroke 1.75 in currentColor. */
export function Icon({ name, size, label, className, ...rest }: IconProps) {
  const { icons } = useTheme()
  return (
    <svg
      className={className ? `sx-ic ${className}` : 'sx-ic'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      // Paths come from the generated icon file or the integrator's overrides, never from user input.
      dangerouslySetInnerHTML={{ __html: icons[name] ?? ICON_PATHS[name] }}
      {...rest}
    />
  )
}

/** Type guard for icon names coming from data (command registries, plugin manifests). */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && Object.hasOwn(ICON_PATHS, value)
}
