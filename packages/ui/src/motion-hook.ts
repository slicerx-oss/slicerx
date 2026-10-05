// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useSyncExternalStore } from 'react'
import { motionReduced, subscribeMotion } from './motion'

/** motionReduced() for components, updated when the Motion choice or the system setting changes. */
export function useMotionReduced(): boolean {
  return useSyncExternalStore(subscribeMotion, motionReduced, () => false)
}
