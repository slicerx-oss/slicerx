// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ReactNode } from 'react'
import { Text, type StyleProp, type TextProps, type TextStyle } from 'react-native'
import { t, type, type TypeVariant } from './theme'

export interface TxtProps extends Omit<TextProps, 'style'> {
  variant?: TypeVariant | undefined
  color?: string | undefined
  /** Use sparingly: muted for labels, dim for captions. */
  tone?: 'fg' | 'muted' | 'dim' | undefined
  align?: 'left' | 'center' | 'right' | undefined
  style?: StyleProp<TextStyle> | undefined
  children?: ReactNode | undefined
}

/** All text in the app goes through this, so fonts and sizes stay on the scale. */
export function Txt({ variant = 'body', color, tone = 'fg', align, style, children, ...rest }: TxtProps) {
  const base = type[variant]
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={variant === 'display' ? 1.3 : 1.8}
      style={[base, { color: color ?? t.color[tone] }, align ? { textAlign: align } : null, style]}
    >
      {children}
    </Text>
  )
}
