// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Haptics by meaning and reduced motion. Screens call these names
// instead of expo modules so the feel stays consistent and tests mock one file.
import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import * as Haptics from 'expo-haptics'

let hapticsOn = true

/** Follows the Haptics switch in settings. */
export function setHapticsEnabled(on: boolean): void {
  hapticsOn = on
}

function fire(run: () => Promise<void>): void {
  if (!hapticsOn) return
  // Haptics are best effort: a device without a motor rejects, and there is nothing to show for it.
  run().catch(() => undefined)
}

export const haptic = {
  /** A control changed value: a segment, a switch, a chip. */
  select: () => fire(() => Haptics.selectionAsync()),
  /** A press that starts something. */
  tap: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** Pull to refresh crossed its threshold, a sheet snapped. */
  snap: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
}

/** True while the person asked the OS for reduced motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (live) setReduced(v)
      })
      // Unknown means full motion, the platform default.
      .catch(() => undefined)
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      live = false
      sub.remove()
    }
  }, [])
  return reduced
}
