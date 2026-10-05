// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shared 24px icon set drawn with react-native-svg. The markup comes from @slicerx/ui, so the
// phone and the desktop draw the same icons; each icon is parsed once and cached.
import { memo, type ReactElement } from 'react'
import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg'
import { ICON_PATHS, ICON_STROKE, ICON_VIEWBOX, type IconName } from '@slicerx/ui/icons'
import { t } from './theme'

export type { IconName }

const ELEMENTS = { path: Path, rect: Rect, circle: Circle, ellipse: Ellipse, line: Line, polyline: Polyline, polygon: Polygon } as const
type Tag = keyof typeof ELEMENTS

interface Shape {
  tag: Tag
  props: Record<string, string>
}

const TAG_RE = /<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g
const ATTR_RE = /([a-zA-Z-]+)="([^"]*)"/g
const camel = (k: string) => k.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())

/** Parses the icon markup (self-closing shapes only, which is all the set uses). */
export function parseIcon(markup: string): Shape[] {
  const shapes: Shape[] = []
  for (const m of markup.matchAll(TAG_RE)) {
    const props: Record<string, string> = {}
    for (const a of (m[2] ?? '').matchAll(ATTR_RE)) {
      const key = a[1]
      if (key !== undefined) props[camel(key)] = a[2] ?? ''
    }
    shapes.push({ tag: m[1] as Tag, props })
  }
  return shapes
}

const cache = new Map<IconName, Shape[]>()
function shapesFor(name: IconName): Shape[] {
  let s = cache.get(name)
  if (!s) {
    s = parseIcon(ICON_PATHS[name])
    cache.set(name, s)
  }
  return s
}

export interface IconProps {
  name: IconName
  size?: number
  color?: string
  /** Stroke width on the 24px grid. The set is drawn for 1.75. */
  stroke?: number
  /** Accessible name. Without one the icon is decorative and hidden from screen readers. */
  label?: string
  testID?: string
}

export const Icon = memo(function Icon({ name, size = 22, color = t.color.fg, stroke = ICON_STROKE, label, testID }: IconProps) {
  const children: ReactElement[] = shapesFor(name).map((s, i) => {
    const El = ELEMENTS[s.tag] as unknown as (p: Record<string, unknown>) => ReactElement
    return <El key={i} {...s.props} />
  })
  return (
    <Svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke={color}
      color={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { accessible: true, role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true })}
      testID={testID ?? `icon-${name}`}
    >
      {children}
    </Svg>
  )
})
