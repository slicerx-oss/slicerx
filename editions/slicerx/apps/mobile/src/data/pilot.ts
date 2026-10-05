// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir on the phone: the shared runtime, tools and approval gate over the Pocket
// host. Without a model transport it answers with the offline client (src/pilot).
import type { ApprovalRequest, PermissionPolicy, SessionSummary } from '@slicerx/contracts'
import { createPilot, DEFAULT_CONFIG } from '@slicerx/pilot'
import { usePilotRun } from '@slicerx/pilot/run'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createDemoClient } from '../pilot/demo-client'
import { bundledKb } from './kb'
import { get, set, usePocket } from '../state/store'
import { usePocketHost } from './provider'

const newId = (): string => `pocket-${Date.now().toString(36)}`

export function usePocketPilot() {
  const host = usePocketHost()
  const policy = usePocket((s) => s.policy)
  const sessions = usePocket((s) => s.sessions)
  const ai = host.edition.ai
  const config = useMemo(() => ({ ...DEFAULT_CONFIG, provider: ai.provider, model: ai.model }), [ai.provider, ai.model])
  const { data: live } = useQuery({ queryKey: ['llm', config.provider], queryFn: () => host.llm.available(config.provider).catch(() => false), staleTime: Infinity })
  const connected = live === true

  const pilot = useMemo(
    () =>
      createPilot({
        host: { printers: host.printers, slicer: host.slicer, llm: host.llm, approvals: host.approvals },
        config,
        policy: get().policy,
        kb: bundledKb(),
        ...(connected ? {} : { client: createDemoClient() }),
      }),
    [host, config, connected],
  )
  useEffect(() => pilot.setPolicy(policy), [pilot, policy])

  const [sessionId, setSessionId] = useState(newId)
  const run = usePilotRun(pilot, sessionId, {})

  // Keep the session list's status in step with the run on screen.
  const status = run.transcript.status
  useEffect(() => {
    if (status === 'idle') return
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, status } : x)) }))
  }, [sessionId, status])

  const send = useCallback(
    (text: string) => {
      const msg = text.trim()
      if (!msg || run.running) return
      if (!get().sessions.some((x) => x.id === sessionId)) {
        const entry: SessionSummary = { id: sessionId, title: msg.slice(0, 80), status: 'running', startedAt: new Date().toISOString() }
        set((s) => ({ sessions: [entry, ...s.sessions].slice(0, 30) }))
      }
      run.run(msg)
    },
    [run, sessionId],
  )

  return {
    transcript: run.transcript,
    running: run.running,
    connected,
    sessions,
    sessionId,
    send,
    stop: run.cancel,
    newSession: () => {
      run.cancel()
      setSessionId(newId())
      run.reset()
    },
    approve: (r: ApprovalRequest, o: { bedClear: boolean }) => pilot.resolveApproval(r.id, o.bedClear ? { kind: 'approve', bedClear: true } : { kind: 'approve' }),
    deny: (r: ApprovalRequest) => pilot.resolveApproval(r.id, { kind: 'deny', reason: 'canceled' }),
    setPolicy: (p: PermissionPolicy) => set({ policy: p }),
  }
}
