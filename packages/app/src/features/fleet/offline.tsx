// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer that is not reachable: the ravens rest and breathe slowly over when it was last seen,
// with Try again to ask every printer for its status now.
import { Button } from '@slicerx/ui'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { CameraIdle } from '../../camera/idle'
import { lastSeenAt } from '../../lib/last-seen'

/**
 * "Last seen 4 min ago" from the last time the printer reported in while reachable. Seconds ago means
 * the link just dropped; never seen on this computer says so.
 */
export function lastSeen(seenAt: string | undefined, now: number): string {
  const at = Date.parse(seenAt ?? '')
  if (!Number.isFinite(at)) return 'Not seen on this computer yet'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'Lost the connection'
  if (s < 3600) return `Last seen ${Math.round(s / 60)} min ago`
  if (s < 86_400) return `Last seen ${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86_400)
  return `Last seen ${d} ${d === 1 ? 'day' : 'days'} ago`
}

export function OfflineIdle({ printerId, now, size = 'sm' }: { printerId: string; now: number; size?: 'sm' | 'lg' }) {
  const qc = useQueryClient()
  const checking = useIsFetching({ queryKey: ['fleet'] }) > 0
  return (
    <CameraIdle
      breathe
      size={size}
      text={lastSeen(lastSeenAt(printerId), now)}
      detail="The printer is not reachable. Check that it is on and on the same network as this computer."
      showDetail={size === 'lg'}
      action={
        <Button size="sm" variant="ghost" icon="refresh" className="cam-idle-act" disabled={checking} onClick={() => void qc.invalidateQueries({ queryKey: ['fleet'] })}>
          {checking ? 'Checking' : 'Try again'}
        </Button>
      }
    />
  )
}
