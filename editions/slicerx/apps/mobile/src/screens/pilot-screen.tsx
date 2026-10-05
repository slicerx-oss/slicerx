// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir chat, reached from a printer. Streams replies, folds thinking, shows tool rows and approval cards
// the person answers with a tap.
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, View } from 'react-native'
import type { ApprovalRequest, SessionSummary } from '@slicerx/contracts'
import { IconButton } from '../components/button'
import { Row, Screen, ScreenHeader } from '../components/layout'
import { Mark } from '../components/mark'
import { Composer, type Suggestion } from '../components/pilot/composer'
import { fmtWhen, type Transcript } from '../components/pilot/model'
import { TranscriptList } from '../components/pilot/transcript-list'
import { Sheet } from '../components/sheet'
import { Pill, type StatusTone } from '../components/status'
import { Txt } from '../components/text'
import { t } from '../components/theme'

export interface PilotScreenProps {
  transcript: Transcript
  sessions: SessionSummary[]
  activeSessionId: string | null
  /** False when no paired computer or cloud runtime can run mimir right now. */
  connected: boolean
  suggestions: Suggestion[]
  onSend: (text: string) => void
  onStop: () => void
  onApprove: (r: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onDeny: (r: ApprovalRequest) => Promise<void>
  onRetry?: () => void
  onOpenSession: (id: string) => void
  onNewSession: () => void
  onOpenNotifications: () => void
  unreadNotifications: number
  /** Present when the chat was pushed from a printer; shows a back button in place of the mark. */
  onBack?: (() => void) | undefined
  /** Clock for session times, for tests. */
  now?: number
}

const SESSION_TONE: Record<SessionSummary['status'], [StatusTone, string]> = {
  running: ['live', 'Running'],
  done: ['ok', 'Done'],
  stopped: ['attention', 'Stopped'],
  error: ['error', 'Error'],
}

export function PilotScreen(p: PilotScreenProps) {
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const running = p.transcript.status === 'running'
  const subtitle = !p.connected ? 'Not connected' : running ? 'Working' : (p.transcript.model ?? 'Ready')

  const header = (
    <ScreenHeader
      title="mimir"
      subtitle={subtitle}
      leading={p.onBack ? <IconButton icon="chevron-left" label="Back" onPress={p.onBack} color={t.color.fg} testID="pilot-back" /> : <Mark size={26} />}
      actions={
        <>
          <IconButton icon="history" label="Sessions" onPress={() => setSessionsOpen(true)} testID="open-sessions" />
          <IconButton icon="notification" label="Notifications" onPress={p.onOpenNotifications} badge={p.unreadNotifications > 0} testID="open-notifications" />
          <IconButton icon="plus" label="New session" onPress={p.onNewSession} disabled={running} testID="new-session" />
        </>
      }
    />
  )

  const empty = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space(5), gap: t.space(1.5) }} testID="pilot-empty">
      <Mark size={44} />
      <Txt variant="title" align="center">
        What should we print?
      </Txt>
      <Txt variant="caption" tone="muted" align="center" style={{ fontSize: 15, lineHeight: 22 }}>
        {p.connected
          ? 'mimir plans, slices and checks your printers. It asks you before anything reaches a printer.'
          : 'Pair a computer running SlicerX to use mimir from your phone.'}
      </Txt>
    </View>
  )

  return (
    <Screen header={header} scroll={false} testID="pilot-screen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TranscriptList transcript={p.transcript} onApprove={p.onApprove} onDeny={p.onDeny} empty={empty} {...(p.onRetry ? { onRetry: p.onRetry } : {})} />
        <Composer
          onSend={p.onSend}
          onStop={p.onStop}
          running={running}
          disabled={!p.connected}
          suggestions={p.transcript.turns.length === 0 && p.connected ? p.suggestions : []}
        />
      </KeyboardAvoidingView>
      <Sheet open={sessionsOpen} onClose={() => setSessionsOpen(false)} title="Sessions" testID="sessions-sheet">
        {p.sessions.length === 0 ? (
          <Txt variant="caption" tone="muted" style={{ paddingHorizontal: t.gutter, paddingBottom: t.space(2) }}>
            No sessions yet
          </Txt>
        ) : (
          p.sessions.map((s) => {
            const [tone, label] = SESSION_TONE[s.status]
            return (
              <Row
                key={s.id}
                title={s.title}
                detail={fmtWhen(s.startedAt, p.now ?? Date.now())}
                mono
                icon={s.id === p.activeSessionId ? 'check' : 'pilot'}
                iconColor={s.id === p.activeSessionId ? t.color.purple : t.color.dim}
                trailing={<Pill tone={tone} label={label} pulse={s.status === 'running'} />}
                onPress={() => {
                  setSessionsOpen(false)
                  p.onOpenSession(s.id)
                }}
                testID={`session-${s.id}`}
              />
            )
          })
        )}
      </Sheet>
    </Screen>
  )
}
