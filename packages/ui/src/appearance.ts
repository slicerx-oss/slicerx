// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text size and font weight, from Settings > Look and feel. Both move the type tokens on the root:
// every type size multiplies by --text-scale, and the four weights step together, so a component
// that uses the tokens follows without knowing about the setting.

export const TEXT_SIZES = ['small', 'default', 'large', 'larger'] as const
export type TextSize = (typeof TEXT_SIZES)[number]
export const FONT_WEIGHTS = ['light', 'regular', 'medium', 'bold'] as const
export type FontWeight = (typeof FONT_WEIGHTS)[number]

/** The multiplier for each text size. Default is 14 px body text. */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { small: 0.92, default: 1, large: 1.14, larger: 1.29 }

/** Regular, medium, semibold and bold for each body weight. Labels and titles step up from the body. */
export const WEIGHT_STEPS: Readonly<Record<FontWeight, readonly [number, number, number, number]>> = {
  light: [300, 400, 500, 600],
  regular: [400, 500, 600, 700],
  medium: [500, 600, 650, 750],
  bold: [600, 700, 750, 800],
}

/** Body text size in px for a text size, for labels like "Body text at 16 px". */
export function bodyPx(size: TextSize): number {
  return Math.round(14 * TEXT_SCALE[size] * 2) / 2
}

/** The custom properties a text size and weight set. */
export function typeVars(size: TextSize, weight: FontWeight): Record<string, string> {
  const [regular, medium, semibold, bold] = WEIGHT_STEPS[weight]
  return {
    '--text-scale': String(TEXT_SCALE[size]),
    '--fw-regular': String(regular),
    '--fw-medium': String(medium),
    '--fw-semibold': String(semibold),
    '--fw-bold': String(bold),
  }
}

/** Sets the type tokens on the element (the document root by default) and records the choice in data-text-size and data-font-weight. */
export function applyType(size: TextSize, weight: FontWeight, el?: HTMLElement): void {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!target) return
  for (const [k, v] of Object.entries(typeVars(size, weight))) target.style.setProperty(k, v)
  target.dataset['textSize'] = size
  target.dataset['fontWeight'] = weight
}
