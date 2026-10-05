// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Status pills, progress bars and the live dot. Color carries meaning: cyan is live, green ok,
// orange needs you, red error, dim off.
import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { useReducedMotion } from './feedback'
import { Txt } from './text'
import { font, mix, t } from './theme'

export type StatusTone = 'live' | 'ok' | 'attention' | 'error' | 'off' | 'accent'

const TONE: Record<StatusTone, string> = {
  live: t.color.cyan,
  ok: t.color.green,
  attention: t.color.orange,
  error: t.color.red,
  off: t.color.dim,
  accent: t.color.purple,
}

export function toneOf(s: StatusTone): string {
  return TONE[s]
}

export function Pill({ tone, label, pulse, testID }: { tone: StatusTone; label: string; pulse?: boolean; testID?: string }) {
  const c = TONE[tone]
  return (
    <View style={[styles.pill, { backgroundColor: mix(c, t.color.ink1, 12) }]} testID={testID}>
      <Dot color={c} pulse={pulse === true} />
      <Txt variant="caption" color={c} style={{ fontFamily: font.bodySemi }} numberOfLines={1}>
        {label}
      </Txt>
    </View>
  )
}

/** A 7pt dot that breathes while something is live, unless reduced motion is on. */
export function Dot({ color, pulse, size = 7 }: { color: string; pulse?: boolean; size?: number }) {
  const reduced = useReducedMotion()
  const o = useRef(new Animated.Value(1)).current
  const animate = pulse === true && !reduced
  useEffect(() => {
    if (!animate) {
      o.setValue(1)
      return undefined
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [animate, o])
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: o }} />
}

export interface ProgressBarProps {
  /** 0 to 1. */
  value: number
  tone?: StatusTone
  height?: number
  label?: string
}

export function ProgressBar({ value, tone = 'live', height = 4, label }: ProgressBarProps) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <View
      accessible
      role="progressbar"
      aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}
      style={[styles.track, { height, borderRadius: height / 2 }]}
    >
      <View style={{ width: `${v * 100}%`, height, borderRadius: height / 2, backgroundColor: TONE[tone] }} />
    </View>
  )
}

/** Placeholder block for skeleton loading. Pulses gently; still under reduced motion. */
export function Skeleton({ width, height = 14, radius = t.radius.sm, style }: { width: number | `${number}%`; height?: number; radius?: number; style?: object }) {
  const reduced = useReducedMotion()
  const o = useRef(new Animated.Value(0.5)).current
  useEffect(() => {
    if (reduced) return undefined
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(o, { toValue: 0.5, duration: 800, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduced, o])
  return <Animated.View aria-hidden style={[{ width, height, borderRadius: radius, backgroundColor: t.color.ink3, opacity: o }, style]} />
}

/** Three skeleton rows shaped like list rows, shown while a list loads for the first time. */
export function SkeletonRows({ count = 3, thumb }: { count?: number; thumb?: boolean }) {
  return (
    <View accessible aria-label="Loading" testID="skeleton">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.skRow}>
          {thumb ? <Skeleton width={52} height={52} radius={t.radius.md} /> : null}
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="55%" height={15} />
            <Skeleton width="80%" height={12} />
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, height: 24, borderRadius: t.radius.pill, alignSelf: 'flex-start' },
  track: { backgroundColor: t.color.ink4, overflow: 'hidden', alignSelf: 'stretch' },
  skRow: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5), paddingVertical: t.space(1.5), paddingHorizontal: t.gutter },
})
