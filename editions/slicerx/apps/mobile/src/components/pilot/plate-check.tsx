// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate on a start card approved away from home: the camera's still of the plate now, beside the empty-plate
// picture the person took, and what the computer's camera guard made of them. The card's Approve waits for a check
// that passed in the last minute; Check again takes a new one.
import { useCallback, useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import type { PlateCheck } from '@slicerx/pair'
import { Button } from '../button'
import { Txt } from '../text'
import { t } from '../theme'

/** Where a start card gets its plate check (`plate.check` on the computer's hub). */
export interface PlateCheckSource {
  printerId: string
  windowSeconds: number
  check: () => Promise<PlateCheck>
}

/** The words under the pictures, from what the hub said. */
export function plateWords(c: PlateCheck | null, left: number | null): { text: string; ok: boolean } {
  if (!c) return { text: 'Checking the plate', ok: false }
  if (!c.checked) return { text: 'The camera guard did not answer. Check again, or approve this at home', ok: false }
  if (c.passes && left !== null && left > 0) return { text: `The plate looks clear. Approve within ${Math.ceil(left / 1000)} s, or check again`, ok: true }
  if (c.passes) return { text: 'This check is too old. Check again', ok: false }
  const m = c.message ?? 'The plate check did not pass'
  return { text: `${m.charAt(0).toUpperCase()}${m.slice(1)}`, ok: false }
}

function Picture({ label, pic, testID }: { label: string; pic: PlateCheck['still']; testID: string }) {
  return (
    <View style={styles.pic}>
      {pic ? (
        <Image source={{ uri: `data:${pic.contentType};base64,${pic.dataB64}` }} style={styles.img} resizeMode="cover" accessibilityLabel={label} accessibilityIgnoresInvertColors testID={testID} />
      ) : (
        <View style={[styles.img, styles.none]} testID={`${testID}-none`}>
          <Txt variant="caption" tone="dim">
            No picture
          </Txt>
        </View>
      )}
      <Txt variant="caption" tone="muted">
        {label}
      </Txt>
    </View>
  )
}

/**
 * Runs the plate check when shown and on Check again. `onPass` gets the time (Unix ms) until which an approval may
 * rely on the check, or null when it did not pass.
 */
export function PlateCheckView({ source, onPass, now = Date.now }: { source: PlateCheckSource; onPass: (until: number | null) => void; now?: () => number }) {
  const [c, setC] = useState<PlateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(now)
  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    onPass(null)
    try {
      const r = await source.check()
      setC(r)
      onPass(r.passes && r.passUntil ? r.passUntil : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [source, onPass])
  useEffect(() => {
    void run()
  }, [run])
  useEffect(() => {
    const id = setInterval(() => setClock(now()), 1000)
    return () => clearInterval(id)
  }, [now])
  const left = c?.passUntil ? c.passUntil - clock : null
  const words = error ? { text: error, ok: false } : plateWords(busy ? null : c, left)
  return (
    <View style={styles.box} testID="plate-check">
      <View style={styles.row}>
        <Picture label="Plate now" pic={c?.still ?? null} testID="plate-now" />
        <Picture label="Empty plate" pic={c?.reference ?? null} testID="plate-empty" />
      </View>
      <Txt variant="caption" color={words.ok ? t.color.green : t.color.orange} aria-live="polite" testID="plate-words">
        {words.text}
      </Txt>
      <Button label="Check again" kind="secondary" icon="refresh" busy={busy} disabled={busy} onPress={() => void run()} testID="plate-check-again" />
    </View>
  )
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 16, marginTop: 10, gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  pic: { flex: 1, gap: 4 },
  img: { width: '100%', aspectRatio: 4 / 3, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.color.lineSoft, backgroundColor: t.color.ink0 },
  none: { alignItems: 'center', justifyContent: 'center' },
})
