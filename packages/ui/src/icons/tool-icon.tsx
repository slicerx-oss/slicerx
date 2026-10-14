// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SVGProps } from 'react'
import { TOOL_ICONS, type ToolIconName, type ToolIconSize } from './tool-icons'

export { TOOL_ICONS, TOOL_ICON_GROUPS, type ToolIconName, type ToolIconSize } from './tool-icons'

export interface ToolIconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: ToolIconName
  /** One of the sizes drawn: 32 (the ribbon's Large), 24 (Medium) or 16 (Small and menu rows). */
  size: ToolIconSize
  /** Accessible name. Without one the icon is decorative and hidden from readers. */
  label?: string
}

/** A shaded tool icon, drawn for its size and colored from the --ti-* tokens, so it follows the theme. */
export function ToolIcon({ name, size, label, className, ...rest }: ToolIconProps) {
  return (
    <svg
      className={className ? `ti ${className}` : 'ti'}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-tool-icon={name}
      // Markup comes from the generated table, never from user input.
      dangerouslySetInnerHTML={{ __html: TOOL_ICONS[name][size] }}
      {...rest}
    />
  )
}
