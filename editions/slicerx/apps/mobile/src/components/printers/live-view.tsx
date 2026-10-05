// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera picture: frames from a feed drawn without flicker, with how they arrive (live or
// stills) in the corner. Overlays (state pill, progress edge, time left) come in as children so the
// list tile and the printer page share one view.
import { useEffect, useState, type ReactNode } from 'react'
import { type LayoutChangeEvent } from 'react-native'
import { Image, StyleSheet, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import type { FeedView } from '../../camera/use-feed'
import { Icon } from '../icon'
import { Dot, Skeleton } from '../status'
import { Txt } from '../text'
import { font, t } from '../theme'
import { loadWebRtc } from '../../camera/webrtc'
import { svgFromDataUri } from './printer-bits'

export interface LiveViewProps extends FeedView {
  /** False when the printer reports no camera. The feed is not opened then. */
  available: boolean
  /** Printer name for the accessible label. */
  name: string
  /** Height over width. 9/16 on the page, a touch shorter in the list. */
  aspect?: number | undefined
  /** Hides the mode badge, for small tiles that show their own caption. */
  quiet?: boolean | undefined
  children?: ReactNode | undefined
  testID?: string | undefined
}

/** Two image slots; a new frame loads behind the visible one and swaps in once decoded. */
function Frames({ uri, label }: { uri: string; label: string }) {
  const [slots, setSlots] = useState<[string | null, string | null]>([uri, null])
  const [front, setFront] = useState<0 | 1>(0)
  useEffect(() => {
    setSlots((s) => {
      if (s[front] === uri) return s
      const next: [string | null, string | null] = [...s]
      next[front === 0 ? 1 : 0] = uri
      return next
    })
  }, [uri, front])
  const back = front === 0 ? 1 : 0
  // Nothing but a quiet skeleton shows until a frame has decoded, so a failed or slow image never
  // leaves its alt text on the tile.
  const [ready, setReady] = useState(false)
  return (
    <View style={styles.fill} accessible role="img" aria-label={label} testID="live-frame">
      {ready ? null : (
        <View style={StyleSheet.absoluteFill}>
          <Skeleton width="100%" height={600} radius={0} />
        </View>
      )}
      {slots.map((src, i) =>
        src ? (
          <Image
            key={i}
            source={{ uri: src }}
            resizeMode="cover"
            style={[styles.fill, StyleSheet.absoluteFill, { opacity: ready && i === front ? 1 : 0 }]}
            onLoad={() => {
              if (!ready) {
                setReady(true)
                return
              }
              if (i === back && slots[back] === uri) setFront(back)
            }}
          />
        ) : null,
      )}
    </View>
  )
}

/** A picture never carries words: caption text inside a demo frame is dropped. */
export function withoutText(svg: string): string {
  return svg.replace(/<text\b[\s\S]*?<\/text>/gi, '')
}

/** A WebRTC video stream in the native view. Without the native module the feed never offers one. */
function RtcFrame({ url, label }: { url: string; label: string }) {
  const View_ = loadWebRtc()?.RTCView
  return (
    <View style={styles.fill} accessible role="img" aria-label={label} testID="live-frame">
      {View_ ? <View_ streamURL={url} objectFit="cover" style={styles.fill} /> : null}
    </View>
  )
}

export function modeLabel(v: Pick<FeedView, 'mode' | 'stats' | 'stale'>): string {
  if (v.stale) return 'No picture'
  if (v.mode === 'live') return v.stats && v.stats.fps > 0 ? `Live, ${v.stats.fps} fps` : 'Live'
  if (v.mode === 'stills') return 'Stills'
  return ''
}

/** Without a picture the box drops to a short strip, so the state and the message still have a stage. */
export const NO_PICTURE_ASPECT = 0.3

export function LiveView(p: LiveViewProps) {
  const svg = p.frame ? svgFromDataUri(p.frame.uri) : null
  const label = `${p.name} camera`
  const badge = modeLabel(p)
  const none = !p.available || p.unavailable
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const onLayout = (e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
  return (
    <View style={[styles.box, { aspectRatio: 1 / (none ? NO_PICTURE_ASPECT : (p.aspect ?? 9 / 16)) }]} onLayout={onLayout} testID={p.testID ?? 'live-view'}>
      {none ? (
        <View style={styles.empty}>
          <Icon name="camera-off" size={24} color={t.color.dim} />
          <Txt variant="caption" tone="dim">
            {p.available ? 'Camera not reachable' : 'No camera on this printer'}
          </Txt>
        </View>
      ) : p.frame === null ? (
        <Skeleton width="100%" height={size?.h ?? 220} radius={0} />
      ) : p.frame.rtcStream ? (
        <RtcFrame url={p.frame.rtcStream} label={label} />
      ) : svg ? (
        <View style={styles.fill} accessible role="img" aria-label={label} testID="live-frame">
          <SvgXml xml={withoutText(svg)} width={size?.w ?? '100%'} height={size?.h ?? '100%'} preserveAspectRatio="xMidYMid slice" />
        </View>
      ) : (
        <Frames uri={p.frame.uri} label={label} />
      )}
      {p.frame && p.stale ? <View style={[StyleSheet.absoluteFill, styles.dim]} /> : null}
      {p.frame && !p.quiet && badge ? (
        <View style={styles.badge} testID="live-badge">
          {p.mode === 'live' && !p.stale ? <Dot color={t.color.cyan} pulse size={6} /> : null}
          <Txt variant="mono" color={p.stale ? t.color.orange : t.color.fg} style={styles.badgeText}>
            {badge}
          </Txt>
        </View>
      ) : null}
      {p.children}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { width: '100%', backgroundColor: t.color.ink1, borderRadius: t.radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: t.color.lineSoft },
  fill: { width: '100%', height: '100%' },
  empty: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
  dim: { backgroundColor: t.color.scrim },
  badge: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: t.radius.pill,
    backgroundColor: t.color.scrim,
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontFamily: font.monoMedium },
})
