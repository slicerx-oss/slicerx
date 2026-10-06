// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The X mark of the wordmark, drawn as nested outlines in the three accent colors, and the app
// mark: huginn perched on three printed layers.
import { useId } from 'react'
import { Text, View } from 'react-native'
import Svg, { Circle, Defs, G, LinearGradient, Mask, Path, Rect, Stop } from 'react-native-svg'
import { MARK_VIEWBOX, markCutFor, markRings, perchCutFor, perchShapes } from '@slicerx/ui/icons'
import { font, t } from './theme'

export interface MarkProps {
  size?: number
  /** Accessible name; without one the mark is decorative. */
  label?: string
}

const ROLE_COLOR = { o: t.gradient.to, m: t.gradient.from, i: t.color.cyan } as const

/** The X mark: nested outlines in pink, purple and cyan, with a heavier cut at small sizes. */
export function Mark({ size = 20, label }: MarkProps) {
  const rings = markRings(markCutFor(size))
  return (
    <Svg
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      {...(label ? { accessible: true, role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true })}
      testID="sx-mark"
    >
      {rings.map((g) =>
        g.width === null ? (
          <Path key={g.role} fill={ROLE_COLOR[g.role]} d={g.path} />
        ) : (
          <Path key={g.role} fill="none" stroke={ROLE_COLOR[g.role]} strokeWidth={g.width} strokeLinejoin="miter" d={g.path} />
        ),
      )}
    </Svg>
  )
}

/** The app mark: huginn on three printed layers in the theme's purple to pink, with a heavier cut at small sizes. */
export function AppMark({ size = 24, label }: MarkProps) {
  const uid = useId().replace(/[^\w-]/g, '')
  const s = perchShapes(perchCutFor(size))
  const g = s.birdGradient
  return (
    <Svg
      width={size}
      height={size}
      viewBox={s.viewBox}
      {...(label ? { accessible: true, role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true })}
      testID="sx-app-mark"
    >
      <Defs>
        <LinearGradient id={`pb${uid}`} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
          <Stop offset="0" stopColor={t.gradient.from} />
          <Stop offset="1" stopColor={t.gradient.to} />
        </LinearGradient>
        <LinearGradient id={`pl${uid}`} gradientUnits="userSpaceOnUse" x1={s.barGradient.x1} y1="0" x2={s.barGradient.x2} y2="0">
          <Stop offset="0" stopColor={t.gradient.from} />
          <Stop offset="1" stopColor={t.gradient.to} />
        </LinearGradient>
        <Mask id={`pc${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <Rect width="100" height="100" fill="white" />
          {s.wing ? (
            <G transform={s.birdTransform}>
              {s.wing.width === null ? (
                <Path d={s.wing.d} fill="black" />
              ) : (
                <Path d={s.wing.d} fill="none" stroke="black" strokeWidth={s.wing.width} strokeLinecap="round" />
              )}
            </G>
          ) : null}
          {s.eye ? <Circle cx={s.eye.cx} cy={s.eye.cy} r={s.eye.r} fill="black" /> : null}
        </Mask>
      </Defs>
      {s.legs ? <Path transform={s.birdTransform} d={s.legs.d} fill="none" stroke={`url(#pb${uid})`} strokeWidth={s.legs.width} /> : null}
      {s.bars.map((b) => (
        <Rect key={b.y} x={b.x} y={b.y} width={b.width} height={b.height} rx={b.rx} fill={`url(#pl${uid})`} />
      ))}
      <G mask={`url(#pc${uid})`}>
        <Path transform={s.birdTransform} d={s.body} fill={`url(#pb${uid})`} />
      </G>
    </Svg>
  )
}

/** "Slicer" with the mark standing in for the X, for the splash and the account header. */
export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessible role="img" aria-label="SlicerX">
      <Text style={{ fontFamily: font.display, fontSize: size, color: t.color.fg, letterSpacing: -0.3 }}>Slicer</Text>
      <View style={{ marginLeft: 1 }}>
        <Mark size={size * 1.05} />
      </View>
    </View>
  )
}
