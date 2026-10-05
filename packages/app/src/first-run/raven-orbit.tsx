// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A connection test that takes a while: huginn and muninn circle the printer, with a three step trail
// read from the real test steps, and land on it when the printer answers.
import { Button, Icon, Raven } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import type { ConnectionMethod } from '@slicerx/printer-catalog'
import type { TestStep, TestStepId } from './setup-host'

/** True once `on` has held for `ms`, and kept after `on` ends until `reset`, so a long wait can land. */
export function useLongWait(on: boolean, reset: boolean, ms = 1200): boolean {
  const [long, setLong] = useState(false)
  useEffect(() => {
    if (reset) return setLong(false)
    if (!on) return
    setLong(false)
    const t = window.setTimeout(() => setLong(true), ms)
    return () => window.clearTimeout(t)
  }, [on, reset, ms])
  return long
}

type TrailState = 'ok' | 'run' | 'bad' | 'wait'

function signInLabel(method: ConnectionMethod | null): string {
  const keys = new Set(method?.fields.map((f) => f.key))
  if (keys.has('accessCode')) return 'Signing in with the access code'
  if (keys.has('apiKey')) return 'Signing in with the API key'
  if (keys.has('password')) return 'Signing in with the password'
  return 'Signing in'
}

/** The test's four steps as three: found, signed in, read. */
export function trail(steps: readonly TestStep[], method: ConnectionMethod | null): { label: string; state: TrailState }[] {
  const of = (...ids: TestStepId[]): TrailState => {
    const s = ids.map((id) => steps.find((x) => x.id === id))
    if (s.some((x) => x?.ok === false)) return 'bad'
    if (s.every((x) => x?.ok === true)) return 'ok'
    if (s.some((x) => x?.running || x?.ok === true)) return 'run'
    return 'wait'
  }
  return [
    { label: 'Found on your network', state: of('reach') },
    { label: signInLabel(method), state: of('sign_in') },
    { label: 'Reading its status and filaments', state: of('read_state', 'read_temperatures') },
  ]
}

/** The printer with the two ravens circling it, or perched on it once it answered. */
export function RavenOrbit({ landed }: { landed: boolean }) {
  return (
    <div className="fr-orbit" data-landed={landed || undefined} aria-hidden="true">
      <span className="fr-orbit-ring" />
      <Icon name="printer-corexy-enclosed" className="fr-orbit-printer" style={{ width: 60, height: 60 }} />
      {landed ? (
        <span className="fr-orbit-perch">
          <Icon name="huginn" className="fr-orbit-perched" style={{ width: 36, height: 36, transform: 'scaleX(-1)' }} />
          <Icon name="huginn" className="fr-orbit-perched" style={{ width: 36, height: 36 }} />
        </span>
      ) : (
        <>
          <span className="fr-orbit-arm">
            <Raven size={40} flap facing="right" />
          </span>
          <span className="fr-orbit-arm fr-orbit-late">
            <Raven size={40} flap facing="right" />
          </span>
        </>
      )}
    </div>
  )
}

/** What a long connection test shows: the ravens, where it is, the trail and Cancel. */
export function OrbitPanel({ title, steps, method, landed, onCancel }: { title: string; steps: readonly TestStep[]; method: ConnectionMethod | null; landed: boolean; onCancel: () => void }) {
  const rows = trail(steps, method)
  return (
    <div className="fr-orbit-panel">
      <RavenOrbit landed={landed} />
      <div className="fr-orbit-side">
        {title ? <p className="fr-orbit-title">{title}</p> : null}
        <ol className="fr-trail">
          {rows.map((r) => (
            <li key={r.label} data-state={r.state}>
              <Icon name={r.state === 'ok' ? 'check' : r.state === 'bad' ? 'close' : r.state === 'run' ? 'refresh' : 'minus'} size={15} />
              <span>{r.label}</span>
            </li>
          ))}
        </ol>
        {landed ? null : (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
