// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Session logs. The runtime never puts approval tokens or keys into events,
// and `scrub` removes anything shaped like one as a second line of defense.
import type { PilotEvent, SessionStore, SessionSummary } from '@slicerx/contracts'

const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g
const SECRETISH_TEST = new RegExp(SECRETISH.source)

export function scrub(ev: PilotEvent): PilotEvent {
  const s = JSON.stringify(ev)
  if (!SECRETISH_TEST.test(s)) return ev
  return JSON.parse(s.replace(SECRETISH, '[redacted]')) as PilotEvent
}

export function summarize(id: string, events: PilotEvent[]): SessionSummary {
  const start = events.find((e) => e.type === 'start')
  const done = [...events].reverse().find((e) => e.type === 'done')
  const firstText = events.find((e) => e.type === 'summary')
  const summary: SessionSummary = {
    id,
    title: firstText && firstText.type === 'summary' ? firstText.title : id,
    status: !done ? 'running' : done.type === 'done' && done.stopReason === 'end' ? 'done' : done.type === 'done' && done.stopReason === 'error' ? 'error' : 'stopped',
    startedAt: start && start.type === 'start' ? start.at : '',
  }
  if (done && done.type === 'done') summary.ms = done.ms
  return summary
}

export function createMemorySessionStore(): SessionStore & { dump(): Map<string, PilotEvent[]> } {
  const logs = new Map<string, PilotEvent[]>()
  return {
    async append(sessionId, event) {
      const list = logs.get(sessionId) ?? []
      list.push(scrub(event))
      logs.set(sessionId, list)
    },
    async read(sessionId) {
      return [...(logs.get(sessionId) ?? [])]
    },
    async list() {
      return [...logs.entries()].map(([id, evs]) => summarize(id, evs))
    },
    dump: () => logs,
  }
}
