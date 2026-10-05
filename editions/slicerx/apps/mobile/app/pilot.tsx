// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir, opened from a printer. A `prompt` param is asked as soon as the chat is ready.
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef } from 'react'
import { usePocketPilot } from '../src/data/pilot'
import { usePocket } from '../src/state/store'
import { PilotScreen } from '../src/screens/pilot-screen'

const SUGGESTIONS = [
  { id: 'status', label: 'How are my printers doing?', prompt: 'How are my printers doing?' },
  { id: 'attention', label: 'What needs my attention?', prompt: 'What needs my attention?' },
  { id: 'plan', label: 'Plan a print', prompt: 'Help me plan a print on the printer that is free' },
]

export default function PilotRoute() {
  const { prompt } = useLocalSearchParams<{ prompt?: string }>()
  const p = usePocketPilot()
  const unread = usePocket((s) => s.alerts.filter((a) => !a.read).length)
  const asked = useRef(false)
  const { send } = p
  useEffect(() => {
    if (asked.current || !prompt) return
    asked.current = true
    send(prompt)
  }, [prompt, send])
  return (
    <PilotScreen
      transcript={p.transcript}
      sessions={p.sessions}
      activeSessionId={p.sessionId}
      connected={p.connected}
      suggestions={SUGGESTIONS}
      onSend={p.send}
      onStop={p.stop}
      onApprove={p.approve}
      onDeny={p.deny}
      // Past sessions are listed; reopening one needs the session log store (not on the phone yet).
      onOpenSession={() => undefined}
      onNewSession={p.newSession}
      onOpenNotifications={() => router.push('/notifications')}
      unreadNotifications={unread}
      onBack={() => router.back()}
    />
  )
}
