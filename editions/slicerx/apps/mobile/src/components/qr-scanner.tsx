// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Full-width camera view that reads one QR code, with a plain square frame to aim at.
import { useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { CameraView } from 'expo-camera'
import { haptic } from './feedback'
import { t } from './theme'

export interface QrScannerProps {
  /** Called once with the first QR payload read. Remount to scan again. */
  onScanned: (data: string) => void
}

export function QrScanner({ onScanned }: QrScannerProps) {
  const done = useRef(false)
  return (
    <View style={styles.wrap} testID="qr-scanner">
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          // The camera reports the same code many times a second; only the first one counts.
          if (done.current) return
          done.current = true
          haptic.success()
          onScanned(data)
        }}
        aria-label="Camera. Point it at the QR code on your computer"
      />
      <View style={styles.frame} pointerEvents="none">
        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
          <View key={c} style={[styles.corner, CORNER[c]]} />
        ))}
      </View>
    </View>
  )
}

const L = 28
const W = 3
const CORNER = {
  tl: { top: 0, left: 0, borderTopWidth: W, borderLeftWidth: W, borderTopLeftRadius: 10 },
  tr: { top: 0, right: 0, borderTopWidth: W, borderRightWidth: W, borderTopRightRadius: 10 },
  bl: { bottom: 0, left: 0, borderBottomWidth: W, borderLeftWidth: W, borderBottomLeftRadius: 10 },
  br: { bottom: 0, right: 0, borderBottomWidth: W, borderRightWidth: W, borderBottomRightRadius: 10 },
} as const

const styles = StyleSheet.create({
  wrap: { aspectRatio: 1, width: '100%', borderRadius: t.radius.lg, overflow: 'hidden', backgroundColor: t.color.ink1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: '62%', aspectRatio: 1 },
  corner: { position: 'absolute', width: L, height: L, borderColor: t.color.fg },
})
