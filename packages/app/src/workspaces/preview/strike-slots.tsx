// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slots for heimdall's strike marks and list. Nothing renders, and nothing loads, until a slice finds a collision.
import { lazy, Suspense, type ComponentProps, type ComponentType } from 'react'
import { collisionsOf } from '../../plate/heimdall'
import { useApp } from '../../state/store'

const marks = () => import('./strike-marks')
const LazyStrip = lazy(() => marks().then((m) => ({ default: m.StripStrikes })))
const LazyTrack = lazy(() => marks().then((m) => ({ default: m.TrackStrikes })))
const LazyTime = lazy(() => marks().then((m) => ({ default: m.TimeStrikes })))
const LazyMoves = lazy(() => marks().then((m) => ({ default: m.MoveStrikes })))
const LazyList = lazy(() => marks().then((m) => ({ default: m.CollisionList })))

function slot<P extends object>(Inner: ComponentType<P>) {
  return function Slot(props: P) {
    const any = useApp((s) => collisionsOf(s).length > 0)
    return any ? (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    ) : null
  }
}

export const StripStrikes = slot<ComponentProps<typeof LazyStrip>>(LazyStrip)
export const TrackStrikes = slot<ComponentProps<typeof LazyTrack>>(LazyTrack)
export const TimeStrikes = slot<ComponentProps<typeof LazyTime>>(LazyTime)
export const MoveStrikes = slot<ComponentProps<typeof LazyMoves>>(LazyMoves)
export const CollisionList = slot<object>(LazyList)
