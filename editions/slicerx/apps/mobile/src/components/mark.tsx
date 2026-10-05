// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The X mark, drawn as nested outlines in the three accent colors.
import { Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { MARK_VIEWBOX, markCutFor, markRings } from '@slicerx/ui/icons'
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
