// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Requests the paired computer sends to this phone (mimir asking to start a print, or another
// phone's job). One at a time in a bottom sheet. Approve is one tap and signs the decision
// with the phone's key; Deny only ever stops an action.
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ApprovalCard } from './pilot/approval-card'
import { Sheet } from './sheet'
import { t } from './theme'

export interface PendingComputerApproval {
  id: string
  hostName: string
  request: ApprovalRequest
  source: 'pilot' | 'pair' | 'host'
  requestedBy?: string | undefined
  blocked?: string | undefined
  /** A G-code line the hub checked, shown whole in a monospace font. */
  code?: string | undefined
  decide: (decision: 'approve' | 'deny', opts?: { bedClear?: boolean }) => Promise<void>
}

export interface ComputerApprovalSheetProps {
  /** Oldest first. The sheet shows the first one that is still open. */
  pending: PendingComputerApproval[]
  /** Called once an answer was signed and sent, or the request expired or was closed. */
  onSettled: (id: string) => void
  now?: () => number
}

export function headingFor(a: Pick<PendingComputerApproval, 'hostName' | 'source' | 'requestedBy'>): string {
  if (a.source === 'pilot') return `mimir on ${a.hostName} needs your approval`
  if (a.source === 'pair') return `${a.requestedBy ?? 'A paired phone'} asks ${a.hostName}`
  return `${a.hostName} needs your approval`
}

export function ComputerApprovalSheet({ pending, onSettled, now = Date.now }: ComputerApprovalSheetProps) {
  const current = pending[0] ?? null
  // The person can close the sheet without answering; the request then simply expires on the computer.
  const [closed, setClosed] = useState<string | null>(null)
  const shown = useRef<PendingComputerApproval | null>(null)
  if (current) shown.current = current
  const a = current ?? shown.current

  // An unanswered request drops out when it expires, so the next one can show.
  useEffect(() => {
    if (!current) return undefined
    const left = Date.parse(current.request.expiresAt) - now()
    if (Number.isNaN(left)) return undefined
    const id = setTimeout(() => onSettled(current.id), Math.max(0, left) + 500)
    return () => clearTimeout(id)
  }, [current, onSettled, now])

  const open = current !== null && closed !== current.id
  if (!a) return null
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (current) {
          setClosed(current.id)
          onSettled(current.id)
        }
      }}
      title="Approval needed"
      detail={pending.length > 1 ? `${pending.length} requests waiting` : undefined}
      testID="computer-approval-sheet"
    >
      <View style={styles.body}>
        <ApprovalCard
          key={a.id}
          request={a.request}
          resolution={null}
          actionable
          heading={headingFor(a)}
          requestedBy={a.source === 'pilot' ? a.requestedBy : undefined}
          blocked={a.blocked}
          code={a.code}
          now={now}
          onApprove={async (r, o) => {
            await a.decide('approve', o)
            onSettled(r.id)
          }}
          onDeny={async (r) => {
            await a.decide('deny')
            onSettled(r.id)
          }}
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({ body: { paddingHorizontal: t.gutter } })
