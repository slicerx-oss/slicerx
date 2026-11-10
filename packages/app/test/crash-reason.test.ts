// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A promise rejection whose reason is not an Error has no stack, so its report carries what can be known: the reason
// and its type, the last shell command that failed (by name only), and where the app runs from (a coarse label).
import { neutralEdition } from '@slicerx/edition-config'
import { describe, expect, it, vi } from 'vitest'
import type { CrashHost } from '../src/bugs/crash'

/** Fresh reports, outbox and store, with `host` as the shell's crash host, started on a desktop build. */
async function start(host: Partial<CrashHost>) {
  localStorage.clear()
  vi.resetModules()
  const reports = await import('../src/bugs/reports')
  const outbox = await import('../src/bugs/outbox')
  const store = await import('../src/state/store')
  store.set({ crashReports: true, printerId: null, workspace: 'prepare' })
  reports.resetBugReports()
  reports.registerCrashHost({ take: async () => ({ reports: [], pageLoads: 1, os: 'macOS 15.1 (aarch64)' }), ack: async () => {}, testPanic: async () => {}, ...host })
  const stop = reports.startBugReports({ kind: 'desktop', build: { version: '0.2.16', commit: 'b45e72f2', sourceUrl: '' } } as never, { ...neutralEdition(), release: { stage: 'pre-alpha' } })
  const done = () => {
    stop()
    reports.registerCrashHost(null)
    reports.resetBugReports()
  }
  return { outbox, done }
}

const reject = (reason: unknown) => window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.resolve() }))

describe('a rejection with a reason that is not an Error', () => {
  it('names the shell command that failed, the reason and its type, and where the app runs from', async () => {
    const { outbox, done } = await start({ lastFailedCommand: () => 'resolve_resource', runsFrom: async () => 'disk image' })
    reject('unknown path')
    await vi.waitFor(() => expect(outbox.queued()).toHaveLength(1))
    const r = outbox.queued()[0]!.report
    expect(r.title).toBe('unknown path')
    expect(r.body).toContain('Reason: unknown path\nReason type: string\nLast failed shell command: resolve_resource\nRuns from: disk image')
    done()
  })

  it('carries no arguments or paths, and says when nothing is known', async () => {
    const { outbox, done } = await start({ lastFailedCommand: () => null, runsFrom: async () => { throw new Error('/Users/sean/Applications/SlicerX.app is gone') } })
    reject({ code: 3, path: '/Users/sean/Downloads/plate.3mf' })
    await vi.waitFor(() => expect(outbox.queued()).toHaveLength(1), { timeout: 3000 })
    const r = outbox.queued()[0]!.report
    expect(r.body).toContain('Reason type: object (Object)')
    expect(r.body).toContain('Last failed shell command: none recorded')
    expect(r.body).toContain('Runs from: unknown')
    expect(JSON.stringify(r)).not.toMatch(/sean|\/Users\//)
    done()
  })

  it('leaves an Error rejection as it was', async () => {
    const { outbox, done } = await start({ lastFailedCommand: () => 'resolve_resource', runsFrom: async () => 'disk image' })
    reject(new Error('boom'))
    await vi.waitFor(() => expect(outbox.queued()).toHaveLength(1))
    expect(outbox.queued()[0]!.report.body).not.toContain('Reason type')
    done()
  })
})
