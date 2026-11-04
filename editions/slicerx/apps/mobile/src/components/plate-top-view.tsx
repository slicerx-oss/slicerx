// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A top view of a printer's bed: outlines in plate mm, the back of the bed at the top, fitted with a little room into a
// box of fixed height. The cards that show where a part sits on the bed draw with it. It is an image to a screen
// reader: the caller names what it shows.
import { StyleSheet, View } from 'react-native'
import Svg, { Polygon } from 'react-native-svg'
import { t } from './theme'

export type Pt = readonly [number, number]

/** One outline of the drawing: its corners in plate mm, its fill and its line. `weight` scales the base line width. */
export interface TopShape {
  pts: readonly Pt[]
  fill: string
  stroke?: string
  weight?: number
  dashed?: boolean
  testID?: string
}

/** The four corners of the box from `a` to `b`. */
export const box = (a: Pt, b: Pt): Pt[] => [a, [b[0], a[1]], b, [a[0], b[1]]]

export interface PlateTopViewProps {
  shapes: readonly TopShape[]
  label: string
  testID?: string
  height?: number
}

export function PlateTopView({ shapes, label, testID, height = 168 }: PlateTopViewProps) {
  const all = shapes.flatMap((s) => s.pts)
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const [lx, hx, ly, hy] = all.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 1, 0, 1]
  const pad = Math.max(hx - lx, hy - ly) * 0.04
  const x0 = lx - pad
  const y0 = ly - pad
  const w = hx - lx + 2 * pad
  const h = hy - ly + 2 * pad
  // Plate y runs to the back; the drawing puts the back at the top.
  const top = (y: number) => y0 + h - (y - y0)
  const line = Math.max(w, h) / 160
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={[styles.drawing, { height }]} testID={testID}>
      <Svg width="100%" height="100%" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        {shapes.map((s, i) => (
          <Polygon
            key={i}
            points={s.pts.map((p) => `${p[0]},${top(p[1])}`).join(' ')}
            fill={s.fill}
            {...(s.stroke ? { stroke: s.stroke, strokeWidth: line * (s.weight ?? 1), strokeLinejoin: 'round' as const } : {})}
            {...(s.dashed ? { strokeDasharray: `${line * 3} ${line * 2}` } : {})}
            {...(s.testID ? { testID: s.testID } : {})}
          />
        ))}
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  drawing: { borderRadius: t.radius.sm, overflow: 'hidden' },
})
